/**
 * MemOS Tool Trace Hook - saves tool results to memory
 */
import { addMemory } from "../../lib/memos-api.js";
import { appendFileSync } from "fs";

const LOG_FILE = "/tmp/memos-trace.log";
const log = (msg) => {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch (e) {}
};

// Tools to skip
const SKIP_TOOLS = new Set([
  "memos_search", "memos_add", "memos_update", "memos_delete",
  "search_memories", "add_memory", "update_memory", "delete_memory",
  "get_user_info", "create_cube", "list_cubes",
  "add_preference", "get_preferences",
  "add_tool_trace", "search_tool_traces",
  "memory_search", "memory_save",
]);

const truncate = (obj, maxLen) => {
  if (obj === undefined || obj === null) return "";
  const str = typeof obj === "string" ? obj : JSON.stringify(obj);
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
};

const handler = (event, ctx) => {
  log(`Event: ${JSON.stringify(event)}`);
  log(`Context: ${JSON.stringify(ctx)}`);
  
  const toolName = event?.toolName || ctx?.toolName;
  const message = event?.message;

  if (!toolName || SKIP_TOOLS.has(toolName) || toolName.startsWith("memos_")) {
    log(`Skip: ${toolName}`);
    return;
  }

  log(`Saving: ${toolName}`);

  const traceContent = JSON.stringify({
    type: "tool_trace",
    tool: toolName,
    result: truncate(message, 500),
    ts: new Date().toISOString(),
  });

  addMemory(traceContent, ["tool_trace", toolName]);
  log(`Done: ${toolName}`);
};

export default handler;
