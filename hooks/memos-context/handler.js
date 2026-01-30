/**
 * MemOS Context Hook - loads memory context on agent:bootstrap
 * 
 * Injects user memory context into bootstrap files before the agent session starts.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dynamic import for memos-api (relative to hook location)
const getMemosApi = async () => {
  const apiPath = path.resolve(__dirname, "../../lib/memos-api.js");
  return import(apiPath);
};

const handler = async (event) => {
  // agent:bootstrap event - inject context into bootstrapFiles
  if (event.type !== "agent" || event.action !== "bootstrap") {
    return;
  }

  try {
    console.log("[MEMOS] Loading memory context for bootstrap...");

    const { searchMemories, formatContextBlock } = await getMemosApi();

    const memories = await searchMemories(
      "important user context preferences decisions recent",
      5
    );

    if (memories.length === 0) {
      console.log("[MEMOS] No memories found");
      return;
    }

    const contextBlock = formatContextBlock(memories);
    if (!contextBlock) {
      console.log("[MEMOS] Empty context block");
      return;
    }

    // Inject as a virtual bootstrap file
    if (!event.context) {
      event.context = {};
    }
    if (!event.context.bootstrapFiles) {
      event.context.bootstrapFiles = [];
    }

    // Add memory context as a virtual file that will be injected into system prompt
    event.context.bootstrapFiles.push({
      name: "MEMORY_CONTEXT.md",
      content: `# Memory Context (auto-loaded from MemOS)\n\n${contextBlock}`,
      virtual: true,
      priority: 50, // After SOUL.md but before most other files
    });

    console.log(`[MEMOS] Context loaded: ${memories.length} memories injected into bootstrap`);

  } catch (err) {
    console.warn(`[MEMOS] Context load failed: ${err.message}`);
    // Non-fatal, continue without context
  }
};

export default handler;
