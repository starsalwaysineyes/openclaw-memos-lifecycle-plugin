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

## Гибридная архитектура: Plugin + MCP

### Решение: Plugin для lifecycle + MCP для tools

```
┌─────────────────────────────────────────────────────────────────────┐
│                              moltbot                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Lifecycle Plugin (thin)                     │  │
│  │                                                                │  │
│  │  command:new:                                                  │  │
│  │    1. search_memories("user context") → recent                │  │
│  │    2. inject into system prompt                               │  │
│  │                                                                │  │
│  │  tool_result_persist:                                         │  │
│  │    → auto-save to tool_mem (async fire-and-forget)            │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                        │
│  ┌───────────────────────────┼───────────────────────────────────┐  │
│  │                    Agent Loop (Claude)                         │  │
│  │                                                                │  │
│  │  Tools (от MemOS MCP):                                        │  │
│  │  ├── search_memories     ← для глубокого поиска              │  │
│  │  ├── add_memory          ← сохранить важное                   │  │
│  │  ├── create_cube         ← организация по проектам            │  │
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

### OpenClaw Internal Hooks

**Важно:** OpenClaw использует Internal Hooks (Gateway Hooks):

| Hook | Тип | Описание |
|------|-----|----------|
| `command:new` | sync | Новая сессия начинается |
| `tool_result_persist` | sync | После выполнения tool |

**НЕ существуют:** `session_start`, `tool_result` — это ПЛАНИРУЕМЫЕ хуки.

### Handler для tool_result_persist

```javascript
// SYNCHRONOUS handler (no async!)
const handler = (event) => {
  const { toolName, message } = event || {};

  if (!toolName || SKIP_TOOLS.has(toolName)) {
    return;
  }

  // Fire-and-forget (void IIFE)
  void (async () => {
    const traceContent = JSON.stringify({
      type: "tool_trace",
      tool: toolName,
      result: truncate(message, 500),
      ts: new Date().toISOString(),
    });
    addMemory(traceContent, ["tool_trace", toolName]);
  })();

  return undefined; // не трансформируем message
};
```

**Ключевые моменты:**
1. Handler должен быть **синхронным** (не async)
2. `event.message` вместо `event.result`
3. Async логику оборачиваем в `void (async () => { ... })()`

---

## Сравнение подходов

| Аспект | Только MCP | Только Plugin | Гибрид (рекомендуется) |
|--------|------------|---------------|------------------------|
| Контекст на старте | ❌ Нет | ✅ Да | ✅ Да |
| MCP инструменты | ✅ Да | ❌ Нет | ✅ Да |
| Auto tool traces | ❌ Нет | ✅ Да | ✅ Да |
| Код плагина | 0 строк | ~300 строк | ~100 строк |

---

## 7 типов памяти в MemOS

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

## API endpoints

| Endpoint | Метод | Описание |
|----------|-------|----------|
| `/product/search` | POST | Семантический поиск |
| `/product/add` | POST | Сохранение памяти |
| `/preference/add` | POST | Добавить предпочтение |
| `/tool/add` | POST | Добавить tool trace |
| `/cube/create` | POST | Создать namespace |

---

## Итого

**Гибридная архитектура даёт:**
- Pre-fetch context при `command:new`
- Auto-save tool traces при `tool_result_persist`
- Полный доступ к 17 MCP tools
- Минимальный код плагина (~100 строк)
