/**
 * MemOS Lifecycle Plugin
 * 
 * Pre-loads memory context before agent starts, saves session summaries after.
 * Uses typed lifecycle hooks: before_agent_start, agent_end
 */
import { searchMemories, formatContextBlock, addMemory, extractFacts } from "./lib/memos-api.js";

// Throttle state for autoCapture
let lastAutoCaptureTime = 0;
const AUTO_CAPTURE_THROTTLE_MS = 10 * 60 * 1000; // 10 minutes

export default {
  id: "openclaw-memos-lifecycle-plugin",
  name: "MemOS Lifecycle",
  description: "Pre-loads memory context, auto-saves session info",
  kind: "lifecycle",

  register(api) {
    console.log("[MEMOS] Registering lifecycle plugin...");
    console.log("[MEMOS] api.on available:", typeof api.on);

    // ═══════════════════════════════════════════════════════════════════════
    // BEFORE AGENT START: Inject memory context into the conversation
    // ═══════════════════════════════════════════════════════════════════════
    console.log("[MEMOS] Registering before_agent_start hook...");
    api.on("before_agent_start", async (event) => {
      console.log("[MEMOS] before_agent_start FIRED! prompt length:", event?.prompt?.length || 0);
      
      // Skip if no prompt
      if (!event.prompt || event.prompt.length < 5) {
        return;
      }

      try {
        console.log("[MEMOS] Loading memory context...");

        // Search for relevant memories based on user's prompt
        const memories = await searchMemories(
          "important user context preferences decisions " + event.prompt.slice(0, 200),
          5
        );

        if (memories.length === 0) {
          console.log("[MEMOS] No relevant memories found");
          return;
        }

        const contextBlock = formatContextBlock(memories);
        if (!contextBlock) {
          return;
        }

        console.log("[MEMOS] Injecting", memories.length, "memories into context");

        // Return prepended context that will be added to the conversation
        return {
          prependContext: `<user_memory_context>\nRelevant memories from MemOS:\n${contextBlock}\n</user_memory_context>`,
        };

      } catch (err) {
        console.warn("[MEMOS] Context load failed:", err.message);
        // Non-fatal, continue without memory context
      }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // AGENT END: Smart extraction of important facts from conversation
    // Throttled to run max once per 10 minutes to avoid excessive LLM calls
    // ═══════════════════════════════════════════════════════════════════════
    api.on("agent_end", async (event) => {
      if (!event.success || !event.messages || event.messages.length === 0) {
        return;
      }

      // Throttle check
      const now = Date.now();
      if (now - lastAutoCaptureTime < AUTO_CAPTURE_THROTTLE_MS) {
        console.log("[MEMOS] autoCapture throttled, skipping");
        return;
      }
      lastAutoCaptureTime = now;

      try {
        // Extract text content from messages
        const conversationParts = [];

        for (const msg of event.messages) {
          if (!msg || typeof msg !== "object") continue;
          
          const role = msg.role;
          if (role !== "user" && role !== "assistant") continue;

          const content = typeof msg.content === "string" 
            ? msg.content 
            : Array.isArray(msg.content)
              ? msg.content
                  .filter(b => b?.type === "text")
                  .map(b => b.text)
                  .join(" ")
              : "";

          if (content) {
            conversationParts.push(`${role}: ${content.slice(0, 1000)}`);
          }
        }

        if (conversationParts.length < 2) {
          return; // Need at least one exchange
        }

        const conversationText = conversationParts.join("\n\n");

        // Use LLM to extract important facts
        console.log("[MEMOS] Extracting facts from conversation...");
        const facts = await extractFacts(conversationText);

        if (facts && facts.length > 0) {
          console.log("[MEMOS] Found", facts.length, "important facts to save");
          
          for (const fact of facts) {
            if (typeof fact === "string" && fact.length > 10) {
              addMemory(fact, ["auto_capture", "fact"]);
            }
          }
        } else {
          console.log("[MEMOS] No important facts to extract");
        }

      } catch (err) {
        console.log("[MEMOS] Fact extraction failed:", err.message);
        // Non-fatal
      }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // TOOL RESULT PERSIST: Save tool execution traces
    // ═══════════════════════════════════════════════════════════════════════
    api.registerHook(["tool_result_persist"], (event, ctx) => {
      const toolName = event?.toolName || ctx?.toolName;
      
      // Skip memory-related tools to avoid recursion
      if (!toolName || 
          toolName.startsWith("memos") || 
          toolName.startsWith("memory") ||
          toolName.startsWith("search_memories")) {
        return;
      }

      const truncate = (obj, maxLen) => {
        if (!obj) return "";
        const str = typeof obj === "string" ? obj : JSON.stringify(obj);
        return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
      };

      const traceContent = JSON.stringify({
        type: "tool_trace",
        tool: toolName,
        result: truncate(event?.message, 300),
        ts: new Date().toISOString(),
      });

      // Fire-and-forget
      addMemory(traceContent, ["tool_trace", toolName]);
    }, { name: "memos-tool-trace" });

    console.log("[MEMOS] Lifecycle plugin registered");
  },
};
