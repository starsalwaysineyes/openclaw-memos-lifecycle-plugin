/**
 * MemOS Tool Trace Hook - saves tool results to memory
 * NOTE: This hook must be SYNCHRONOUS (tool_result_persist doesn't await)
 */
import { addMemory } from "../../lib/memos-api.js";

// Tools to skip (memory tools to avoid recursion)
const SKIP_TOOLS = new Set([
  "memos_search", "memos_add", "memos_update", "memos_delete",
  "search_memories", "add_memory", "update_memory", "delete_memory",
  "get_user_info", "create_cube", "list_cubes",
  "add_preference", "get_preferences",
  "add_tool_trace", "search_tool_traces",
  "memory_search", "memory_save",
]);

// Truncate helper with null safety
const truncate = (obj, maxLen) => {
  if (obj === undefined || obj === null) return "";
  const str = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
};

// SYNCHRONOUS handler (no async!)
const handler = (event) => {
  const { toolName, params, result, success, duration } = event || {};

  // Skip memory tools or missing toolName
  if (!toolName || SKIP_TOOLS.has(toolName) || toolName.startsWith("memos_")) {
    return;
  }

  // Fire-and-forget save (addMemory is already fire-and-forget)
  const traceContent = JSON.stringify({
    type: "tool_trace",
    tool: toolName,
    input: truncate(params, 300),
    output: truncate(result, 500),
    success: success ?? true,
    duration_ms: duration ?? 0,
    ts: new Date().toISOString(),
  });

  addMemory(traceContent, ["tool_trace", toolName]);
};

export default handler;
