---
name: memos-context
description: "Fetches user memory context on agent bootstrap and injects into system prompt"
metadata: {"openclaw":{"emoji":"🧠","events":["agent:bootstrap"]}}
---

# MemOS Context Loader

Loads recent memories from MemOS when a session starts (agent:bootstrap event) and injects them into the bootstrap context.

## How It Works

1. On `agent:bootstrap` event, fetches relevant memories from MemOS API
2. Formats memories as a context block
3. Injects the block into `context.bootstrapFiles` as a virtual file

## Configuration

Uses environment variables:
- `MEMOS_API_URL` - MemOS API URL (default: http://127.0.0.1:8000)
- `MEMOS_USER_ID` - User ID for memory queries (default: "default")
- `INTERNAL_SERVICE_SECRET` - Optional auth header for internal service calls
