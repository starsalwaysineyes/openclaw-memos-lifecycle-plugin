# Seamless Memory Integration: moltbot ↔ MemOS

> Как сделать память MemOS нативной частью moltbot

## Проблема

Сейчас moltbot и MemOS связаны через HTTP REST API:

```
moltbot ──HTTP──> memos-api ──> PostgreSQL/Qdrant
         ~30ms      ~50ms
```

Это добавляет ~80ms+ латентности на каждый запрос к памяти.

---

## Как я (агент) использую память сейчас

Представь, что я — moltbot. Вот как происходит работа с памятью:

### 1. Получение контекста в начале сессии

```
User: "Расскажи о нашем последнем проекте"

Мои мысли:
1. Нужно вспомнить контекст пользователя
2. Вызываю memory_search("проект пользователя")
3. Жду HTTP ответ от MemOS (~80ms)
4. Получаю результаты
5. Формирую ответ
```

### 2. Сохранение важной информации

```
User: "Меня зовут Анатолий, я работаю в fintech"

Мои мысли:
1. Это важная информация о пользователе
2. Вызываю memory_save("User name: Анатолий, domain: fintech")
3. Fire-and-forget в background
4. Отвечаю пользователю
```

### 3. Что меня РАЗДРАЖАЕТ как агента

- **Латентность**: 80ms на каждый поиск — это заметная пауза
- **Отдельный процесс**: Память чувствуется как внешний сервис, а не моя
- **Нет прямого доступа**: Не могу сам индексировать документы
- **Зависимость**: Если MemOS упал — память недоступна

---

## Идеальный сценарий: Бесшовная память

### Как должно работать (моя мечта как агента)

```
┌─────────────────────────────────────────────────────────────┐
│                         moltbot                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           Native Memory Layer (TypeScript)           │    │
│  │                                                       │    │
│  │  memory.search("query") ──> Qdrant (< 5ms)           │    │
│  │  memory.save("content") ──> Background embed + store  │    │
│  │  memory.context() ──> Cached user preferences         │    │
│  │                                                       │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │    │
│  │  │  Embedder   │  │   Qdrant    │  │  PostgreSQL │   │    │
│  │  │  (local/    │  │   Direct    │  │   Direct    │   │    │
│  │  │   gemma)    │  │   Client    │  │   Client    │   │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Ключевое отличие

| Аспект | Сейчас (HTTP) | Идеально (Native) |
|--------|---------------|-------------------|
| Латентность поиска | ~80ms | ~5ms |
| Сохранение | Async HTTP | Async embed + direct insert |
| Доступность | Зависит от MemOS | Независимая |
| Расширяемость | Только API | Полный контроль |

---

## Гибридная архитектура: Plugin + MCP

### Проблема "холодного старта"

При чистом MCP-подходе агент не имеет контекста, пока сам не вызовет `search_memories()`:

```
User: "Привет!"
        ↓
    moltbot (без контекста)
        ↓
    "Привет! Чем могу помочь?"  ← не знает кто пользователь
```

### Решение: Plugin для lifecycle + MCP для tools

```
┌─────────────────────────────────────────────────────────────────────┐
│                              moltbot                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Lifecycle Plugin (thin)                     │  │
│  │                                                                │  │
│  │  session_start:                                                │  │
│  │    1. get_user_info() → preferences                           │  │
│  │    2. search_memories("user context") → recent                │  │
│  │    3. inject into system prompt                               │  │
│  │                                                                │  │
│  │  tool_result:                                                  │  │
│  │    → auto-save to tool_mem (async)                            │  │
│  │                                                                │  │
│  │  session_end:                                                  │  │
│  │    → save session summary (async)                             │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                        │
│  ┌───────────────────────────┼───────────────────────────────────┐  │
│  │                    Agent Loop (Claude)                         │  │
│  │                           │                                    │  │
│  │  System prompt УЖЕ содержит:                                  │  │
│  │  ├── User preferences (от plugin)                             │  │
│  │  └── Recent context (от plugin)                               │  │
│  │                                                                │  │
│  │  Tools (17 от MemOS MCP):                                     │  │
│  │  ├── search_memories     ← для глубокого поиска              │  │
│  │  ├── add_memory          ← сохранить важное                   │  │
│  │  ├── create_cube         ← организация по проектам            │  │
│  │  ├── update_memory       ← редактирование                     │  │
│  │  └── ...                                                       │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
                               │
                               │ SSE
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       MemOS MCP Server (:8001)                       │
│                         17 инструментов                              │
└─────────────────────────────────────────────────────────────────────┘
```

### Минимальный Lifecycle Plugin

```typescript
// moltbot-memos-memory/index.js (v2 - minimal)

const memosLifecyclePlugin = {
  id: "memos-lifecycle",
  name: "MemOS Lifecycle",
  description: "Auto-loads memory context on session start",
  kind: "lifecycle",  // NOT "memory" - не регистрирует tools

  register(api) {
    const config = {
      mcpUrl: api.pluginConfig?.mcpUrl || "http://127.0.0.1:8001",
      userId: api.pluginConfig?.userId || "default"
    };
    const logger = api.logger;

    // ═══════════════════════════════════════════════════════════
    // SESSION START: Pre-fetch context BEFORE first agent response
    // ═══════════════════════════════════════════════════════════
    api.on("session_start", async (event, ctx) => {
      try {
        logger?.info?.("[MEMOS] Pre-fetching user context...");

        // 1. Get user preferences
        const userInfo = await callMcp(config.mcpUrl, "get_user_info", {
          user_id: config.userId
        });

        // 2. Get recent memories for context
        const recentMemories = await callMcp(config.mcpUrl, "search_memories", {
          query: "important user context preferences decisions",
          user_id: config.userId,
          top_k: 5
        });

        // 3. Inject into system prompt
        const contextBlock = formatContextBlock(userInfo, recentMemories);
        ctx.injectSystemPrompt(contextBlock);

        logger?.info?.("[MEMOS] Context loaded:", {
          preferences: userInfo?.preferences?.length || 0,
          memories: recentMemories?.length || 0
        });

      } catch (error) {
        logger?.warn?.("[MEMOS] Failed to pre-fetch context:", error.message);
        // Non-fatal: agent can still work without pre-loaded context
      }
    });

    // ═══════════════════════════════════════════════════════════
    // TOOL RESULT: Auto-save tool traces (async, fire-and-forget)
    // ═══════════════════════════════════════════════════════════
    api.on("tool_result", async (event, ctx) => {
      const { toolName, params, result, success, duration } = event;

      // Skip memory tools to avoid recursion
      if (toolName.startsWith("memos_") || toolName.startsWith("search_")) {
        return;
      }

      // Fire-and-forget: don't await
      callMcp(config.mcpUrl, "add_memory", {
        user_id: config.userId,
        content: JSON.stringify({
          type: "tool_trace",
          tool: toolName,
          input: params,
          output: truncate(result, 500),
          success,
          duration_ms: duration,
          timestamp: new Date().toISOString()
        }),
        tags: ["tool_trace", toolName]
      }).catch(err => {
        logger?.debug?.("[MEMOS] Tool trace save failed:", err.message);
      });
    });

    // ═══════════════════════════════════════════════════════════
    // SESSION END: Save session summary (optional)
    // ═══════════════════════════════════════════════════════════
    api.on("session_end", async (event, ctx) => {
      // Could save conversation summary, learned preferences, etc.
      logger?.debug?.("[MEMOS] Session ended");
    });

    logger?.info?.("[MEMOS] Lifecycle plugin registered");
  }
};

// Helper: Call MCP tool via HTTP
async function callMcp(baseUrl, toolName, params) {
  const response = await fetch(`${baseUrl}/tools/${toolName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params)
  });
  return response.json();
}

// Helper: Format context for system prompt
function formatContextBlock(userInfo, memories) {
  let block = "\n<user_memory_context>\n";

  if (userInfo?.preferences?.length) {
    block += "User preferences:\n";
    for (const pref of userInfo.preferences) {
      block += `- ${pref.type}: ${pref.value}\n`;
    }
  }

  if (memories?.length) {
    block += "\nRecent context:\n";
    for (const mem of memories) {
      block += `- ${mem.content}\n`;
    }
  }

  block += "</user_memory_context>\n";
  return block;
}

function truncate(obj, maxLen) {
  const str = typeof obj === "string" ? obj : JSON.stringify(obj);
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}

export default memosLifecyclePlugin;
```

### Конфигурация moltbot

```json
// ~/.moltbot/config/mcp-servers.json
{
  "mcpServers": {
    "memos": {
      "type": "sse",
      "url": "http://127.0.0.1:8001/sse"
    },
    "krolik": {
      "type": "stdio",
      "command": "/home/krolik/mcp-servers/krolik/run.sh"
    },
    "dozor": {
      "type": "stdio",
      "command": "/home/krolik/mcp-servers/dozor/run-mcp.sh"
    }
  }
}
```

```json
// ~/.moltbot/config/extensions.json
{
  "memos-lifecycle": {
    "mcpUrl": "http://127.0.0.1:8001",
    "userId": "default"
  }
}
```

### Сравнение подходов

| Аспект | Только MCP | Только Plugin | Гибрид (рекомендуется) |
|--------|------------|---------------|------------------------|
| Контекст на старте | ❌ Нет | ✅ Да | ✅ Да |
| 17 MCP инструментов | ✅ Да | ❌ Нет | ✅ Да |
| Auto tool traces | ❌ Нет | ✅ Да | ✅ Да |
| Код плагина | 0 строк | ~300 строк | ~100 строк |
| Дублирование | Нет | Да (свои tools) | Нет |

### Поток данных

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Session Timeline                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ┌─────────┐   ┌───────────────────┐   ┌─────────────────────────┐   │
│  │ Session │   │   Plugin Hook     │   │    Agent Ready          │   │
│  │  Start  │ → │   (pre-fetch)     │ → │    (has context)        │   │
│  └─────────┘   └───────────────────┘   └─────────────────────────┘   │
│                        │                           │                  │
│                        │                           │                  │
│                        ▼                           ▼                  │
│               ┌─────────────────┐         ┌─────────────────┐        │
│               │ get_user_info() │         │ User: "Привет!" │        │
│               │ search_memories │         │                 │        │
│               └────────┬────────┘         └────────┬────────┘        │
│                        │                           │                  │
│                        │                           ▼                  │
│                        │                  ┌─────────────────┐        │
│                        │                  │ Agent response  │        │
│                        │                  │ (WITH context)  │        │
│                        │                  └────────┬────────┘        │
│                        │                           │                  │
│                        │                           ▼                  │
│                        │              ┌─────────────────────────┐    │
│                        │              │ Agent uses MCP tools:   │    │
│                        │              │ - search_memories()     │    │
│                        │              │ - add_memory()          │    │
│                        │              │ - create_cube()         │    │
│                        │              └─────────────────────────┘    │
│                        │                           │                  │
│                        │                           ▼                  │
│                        │              ┌─────────────────────────┐    │
│                        └─────────────>│ Tool result hook:       │    │
│                                       │ auto-save tool trace    │    │
│                                       └─────────────────────────┘    │
│                                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

### Итого: что даёт гибридный подход

| Компонент | Роль | Источник |
|-----------|------|----------|
| **Pre-fetch context** | Загрузка при старте | Plugin hook |
| **17 memory tools** | On-demand операции | MemOS MCP напрямую |
| **Tool traces** | Автосохранение | Plugin hook |
| **Preferences** | В system prompt | Plugin → MCP call |

**Код плагина сокращается с ~300 строк до ~100 строк** — только lifecycle hooks, никакой дублирующей логики.

---

## MemOS 2.0 Stardust: Неиспользуемые инновации

> **Важно:** Текущий плагин использует ~10% возможностей MemOS. Ниже — функции, которые мы НЕ используем, но которые дадут значительные преимущества.

### Текущее использование

| API | Статус | Описание |
|-----|--------|----------|
| `/product/search` | ✅ Используется | Семантический поиск |
| `/product/add` | ✅ Используется | Сохранение памяти |
| `/product/chat` | ❌ Не используется | Chat с контекстом памяти |
| `/product/feedback` | ❌ Не используется | Коррекция памяти |
| `/cube/*` | ❌ Не используется | Memory Cubes (namespaces) |
| `/preference/*` | ❌ Не используется | Предпочтения пользователя |
| `/tool/*` | ❌ Не используется | Tool Memory |
| `/knowledge/*` | ❌ Не используется | Knowledge Base |

### 7 типов памяти в MemOS

MemOS поддерживает 7 типов памяти, moltbot использует только 1:

```
MemOS Memory Types:
├── text_mem      ✅ ИСПОЛЬЗУЕТСЯ  — Текстовые воспоминания
├── act_mem       ❌ —————————————  — Действия и события
├── para_mem      ❌ —————————————  — Параграфы/документы
├── pref_mem      ❌ —————————————  — Предпочтения пользователя
├── tool_mem      ❌ —————————————  — История использования инструментов
├── modal_mem     ❌ —————————————  — Мультимодальная память (изображения)
└── kb_mem        ❌ —————————————  — Knowledge Base документы
```

---

## Roadmap интеграции MemOS 2.0

### Phase 1: Preference Memory (приоритет: ВЫСОКИЙ)

**Что это**: Автоматическое обучение предпочтениям пользователя.

**Текущая проблема**: Каждую сессию moltbot "забывает" как пользователь предпочитает получать ответы.

**MemOS API**:
```bash
# Добавить предпочтение
POST /preference/add
{
  "user_id": "user123",
  "preference_type": "communication_style",
  "preference_value": "concise, technical, no fluff"
}

# Получить предпочтения
GET /preference/get?user_id=user123
```

**Выгода**: Агент "помнит" стиль общения с первого сообщения.

---

### Phase 2: Tool Memory (приоритет: ВЫСОКИЙ)

**Что это**: Запоминание истории использования инструментов агентом.

**Текущая проблема**: Агент не учится на прошлых действиях — может повторять ошибки.

**MemOS API**:
```bash
# Добавить tool trace
POST /tool/add
{
  "user_id": "user123",
  "tool_name": "bash",
  "input": "npm install lodash",
  "output": "added 1 package",
  "success": true
}

# Поиск по tool history
POST /tool/search
{
  "user_id": "user123",
  "query": "install npm packages"
}
```

**Выгода**: Агент учится из прошлых сессий, избегает повторения ошибок.

---

### Phase 3: Memory Cubes (приоритет: СРЕДНИЙ)

**Что это**: Namespaces для изоляции памяти по проектам/темам.

**Текущая проблема**: Вся память в одном пространстве — смешиваются проекты.

**MemOS API**:
```bash
# Создать cube
POST /cube/create
{
  "cube_name": "piternow-project",
  "user_id": "user123"
}

# Добавить память в cube
POST /product/add
{
  "cube_id": "cube-piternow-001",
  "messages": ["piternow uses Next.js 15"]
}

# Поиск в конкретном cube
POST /product/search
{
  "cube_id": "cube-piternow-001",
  "query": "tech stack"
}
```

**Выгода**: Изоляция контекста — не путаются детали разных проектов.

---

### Phase 4: Memory Feedback (приоритет: СРЕДНИЙ)

**Что это**: Коррекция памяти на естественном языке.

**Текущая проблема**: Нет способа "исправить" неверную память.

**MemOS API**:
```bash
POST /feedback/add
{
  "memory_id": "mem-123",
  "feedback": "This is incorrect. The project uses PostgreSQL, not MySQL.",
  "user_id": "user123"
}
```

**Выгода**: Пользователь может сказать "Нет, это неправильно" — и память обновится.

---

### Phase 5: Multi-Modal Memory (приоритет: НИЗКИЙ)

**Что это**: Запоминание изображений, скриншотов, диаграмм.

**Когда нужно**: Когда агент работает с визуальным контентом.

**MemOS API**:
```bash
POST /product/add
{
  "modality": "image",
  "image_url": "data:image/png;base64,...",
  "description": "Architecture diagram for auth flow",
  "user_id": "user123"
}
```

---

### Phase 6: Knowledge Base (приоритет: НИЗКИЙ)

**Что это**: Индексация внешних документов и URL.

**Когда нужно**: Для RAG по документации проектов.

**MemOS API**:
```bash
# Добавить URL для индексации
POST /knowledge/add_url
{
  "url": "https://nextjs.org/docs/app/building-your-application",
  "cube_id": "cube-docs-001"
}

# Добавить документ
POST /knowledge/add_doc
{
  "file_path": "/docs/ARCHITECTURE.md",
  "cube_id": "cube-krolik-001"
}
```

---

## Приоритеты интеграции

```
ВЫСОКИЙ (Phase 1-2):
┌─────────────────────────────────────────────────────────────┐
│  Preference Memory  │  Tool Memory                          │
│  ─────────────────  │  ───────────                          │
│  Помнит стиль       │  Учится из                            │
│  общения            │  прошлых действий                     │
└─────────────────────────────────────────────────────────────┘

СРЕДНИЙ (Phase 3-4):
┌─────────────────────────────────────────────────────────────┐
│  Memory Cubes       │  Memory Feedback                      │
│  ─────────────────  │  ───────────────                      │
│  Изоляция по        │  Коррекция                            │
│  проектам           │  на естеств. языке                    │
└─────────────────────────────────────────────────────────────┘

НИЗКИЙ (Phase 5-6):
┌─────────────────────────────────────────────────────────────┐
│  Multi-Modal        │  Knowledge Base                       │
│  ─────────────────  │  ───────────────                      │
│  Изображения        │  RAG по документам                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Итоговая архитектура с MemOS 2.0

```
┌─────────────────────────────────────────────────────────────────────┐
│                              moltbot                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Full Memory Layer                          │    │
│  │                                                               │    │
│  │  memory_search ────> text_mem, act_mem, para_mem             │    │
│  │  memory_save   ────> text_mem (async)                        │    │
│  │  memory_preference ────> pref_mem                    NEW     │    │
│  │  memory_correct    ────> feedback                    NEW     │    │
│  │                                                               │    │
│  │  [Auto-hooks]                                                 │    │
│  │  on_tool_result ────> tool_mem                       NEW     │    │
│  │  on_session_start ──> load preferences               NEW     │    │
│  │                                                               │    │
│  │  [Context-aware]                                              │    │
│  │  detect_project ────> select cube                    NEW     │    │
│  │                                                               │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                        │
└──────────────────────────────┼───────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         MemOS API                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Cubes:           Memory Types:           Features:                  │
│  ├── piternow     ├── text_mem           ├── Semantic Search         │
│  ├── krolik       ├── pref_mem           ├── Memory Feedback         │
│  ├── n8n          ├── tool_mem           ├── MemScheduler           │
│  └── default      ├── act_mem            └── Multi-Modal            │
│                   └── kb_mem                                         │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## План полной интеграции MemOS 2.0

| Функция | Реализация | Выгода |
|---------|------------|--------|
| Preference Memory | Plugin: `session_start` загружает preferences | Помним стиль общения |
| Tool Memory | Plugin: `tool_result` сохраняет traces | Учимся на прошлых действиях |
| Memory Cubes | MCP: `create_cube`, автовыбор по проекту | Изоляция контекста |
| Memory Feedback | MCP: `add_feedback` | Коррекция ошибок памяти |
| Multi-Modal | MCP: `add_memory` с image | Визуальный контекст |
| Knowledge Base | MCP: `add_url`, `add_doc` | RAG по документации |
| MemScheduler | Уже используется (async_mode в API) | Неблокирующее сохранение |

### Что уже работает через MCP Server

MemOS MCP Server (`:8001`) предоставляет **17 инструментов** — агент может использовать их напрямую:

```
search_memories, add_memory, update_memory, delete_memory,
get_user_info, create_cube, list_cubes,
add_preference, get_preferences,
add_tool_trace, search_tool_traces,
add_feedback, add_url, add_doc, ...
```

### Что добавляет Lifecycle Plugin

Plugin (~100 строк) добавляет **автоматизацию**:

| Hook | Действие |
|------|----------|
| `session_start` | Pre-fetch preferences + recent context → inject в system prompt |
| `tool_result` | Auto-save tool traces (fire-and-forget) |
| `session_end` | Save session summary (опционально) |

**Итог**: Гибридная архитектура даёт 100% возможностей MemOS 2.0 с минимальным кодом.

---

## Справка: Нативная память moltbot

> **Для понимания**: Как работает встроенная память moltbot (без MemOS) — важно для сравнения подходов.

### Архитектура хранения

```
~/.moltbot/
├── config/
│   └── moltbot.json         # Конфигурация
├── memory/                   # SQLite индексы
│   └── <agentId>.sqlite     # Векторный индекс памяти
└── projects/
    └── <project>/
        ├── MEMORY.md         # Курируемая память (основная)
        └── memory/
            └── YYYY-MM-DD.md # Дневные логи (автоматические)
```

### Два типа файлов памяти

| Файл | Назначение | Управление |
|------|------------|------------|
| `MEMORY.md` | Главные факты: архитектура, решения, контакты | Агент пишет сам |
| `memory/YYYY-MM-DD.md` | Дневные логи сессий | Автофлаш при compaction |

### Ключевая особенность: НЕТ `memory_save` инструмента

**moltbot native имеет только 2 инструмента:**

```typescript
// memory-tool.ts

memory_search:
  "Mandatory recall step: semantically search MEMORY.md + memory/*.md..."

memory_get:
  "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines..."
```

**Как происходит сохранение:**
1. Агент напрямую пишет в `MEMORY.md` через инструмент `Edit` / `Write`
2. File watcher (chokidar) обнаруживает изменения
3. Автоматический re-index: чтение → chunking → embedding → SQLite

### SQLite индекс (sqlite-vec)

```sql
-- Таблицы в <agentId>.sqlite
files        -- Метаданные файлов (path, mtime, hash)
chunks       -- Текстовые чанки (file_id, text, from_line, to_line)
chunks_vec   -- Векторные embeddings (vec0 virtual table)
chunks_fts   -- Full-text search (FTS5 virtual table)
embedding_cache  -- Кэш embeddings
```

### Гибридный поиск

```
Query → [Embedding] → Vector Search (70% weight)
                   ↘
                    → BM25 Search (30% weight)
                   ↙
                 Merge + Rerank → Results
```

**Конфигурация по умолчанию:**
```typescript
{
  hybrid: {
    enabled: true,
    vectorWeight: 0.7,    // 70% семантика
    textWeight: 0.3,      // 30% BM25 (keywords)
    candidateMultiplier: 4
  },
  chunking: {
    tokens: 400,          // ~400 токенов на чанк
    overlap: 80           // 80 токенов перекрытия
  },
  query: {
    maxResults: 6,
    minScore: 0.35
  }
}
```

### Провайдеры embeddings

| Provider | Model | Размерность |
|----------|-------|-------------|
| OpenAI | `text-embedding-3-small` | 1536 |
| Gemini | `gemini-embedding-001` | 768 |
| Local | `embeddinggemma-300m` | 768 |

**Fallback цепочка:** `auto` → OpenAI → Gemini → Local → none

### Sync механизмы

```typescript
{
  sync: {
    onSessionStart: true,   // Sync при старте сессии
    onSearch: true,         // Sync перед поиском
    watch: true,            // File watcher (chokidar)
    watchDebounceMs: 1500,  // Debounce изменений
    intervalMinutes: 0,     // Periodic sync (0 = disabled)
    sessions: {
      deltaBytes: 100_000,  // Sync после N байт
      deltaMessages: 50     // Sync после N сообщений
    }
  }
}
```

---

## Сравнение: moltbot native vs MemOS MCP

| Аспект | moltbot Native | MemOS MCP |
|--------|---------------|-----------|
| **Хранение** | Markdown файлы + SQLite | PostgreSQL + Qdrant |
| **Инструменты** | 2 (search, get) | 17 (полный CRUD) |
| **Сохранение** | Агент пишет в файлы напрямую | Explicit `add_memory` tool |
| **Типы памяти** | 1 (text) | 7 (text, pref, tool, act, para, modal, kb) |
| **Изоляция** | По agentId | По cube_id (namespaces) |
| **Embedding** | OpenAI/Gemini/Local | OpenAI/Ollama |
| **Hybrid search** | ✅ 70/30 vector/BM25 | ✅ vector + reranking |
| **Preferences** | ❌ Нет | ✅ pref_mem type |
| **Tool traces** | ❌ Нет | ✅ tool_mem type |
| **Feedback** | ❌ Нет | ✅ Memory correction |
| **Multi-modal** | ❌ Нет | ✅ Images |
| **Latency** | <5ms (local SQLite) | ~80ms (HTTP) |
| **Persistence** | Git-trackable .md files | Database (not git) |

### Когда что использовать

**moltbot Native подходит:**
- Локальная разработка с Git
- Простые сценарии (поиск + чтение)
- Когда важна скорость (<5ms)
- Когда память должна быть в репозитории

**MemOS MCP подходит:**
- Мульти-агентные системы
- Нужны preferences, tool traces, feedback
- Изоляция по проектам (cubes)
- Серверный deployment
- Богатые типы памяти (7 видов)

### Гибридный подход (рекомендуется)

Используем оба:
1. **MemOS MCP** — для persistent memory (preferences, tool traces, decisions)
2. **moltbot Native** — для project-specific memory (MEMORY.md в репозитории)

```
┌─────────────────────────────────────────────────────────┐
│                      moltbot                              │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  Native Memory:              MemOS MCP:                  │
│  ├── MEMORY.md (in repo)     ├── Preferences             │
│  ├── memory/*.md             ├── Tool traces             │
│  └── SQLite index            ├── Cubes (projects)        │
│                              └── Knowledge base           │
│                                                           │
│  Use: project context        Use: user context           │
│  Persist: Git                Persist: Database            │
│  Speed: <5ms                 Speed: ~80ms                 │
│                                                           │
└─────────────────────────────────────────────────────────┘
```
