# openclaw-memos-lifecycle-plugin

OpenClaw lifecycle plugin for MemOS - pre-fetches context and auto-saves tool traces.

## Features

- **Context Loading**: Automatically loads recent memories on session start via `command:new` hook
- **Tool Trace**: Auto-saves tool execution results to MemOS via `tool_result_persist` hook
- **Non-blocking**: Fire-and-forget async saves, doesn't slow down agent responses

## Installation

```bash
openclaw plugins install github:starsalwaysineyes/openclaw-memos-lifecycle-plugin
```

## Configuration

Set environment variables in `~/.openclaw/.env`:

```env
MEMOS_API_URL=http://127.0.0.1:8000
MEMOS_USER_ID=default
```

## Hooks

| Hook | Event | Purpose |
|------|-------|--------|
| memos-context | `command:new` | Load memories on session start |
| memos-trace | `tool_result_persist` | Save tool results to memory |

## License

MIT
