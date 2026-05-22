import { MemoryEngine } from "../src/memory/engine.js";
import { EXTRACT_MEMORIES_SYSTEM_PROMPT, formatExtractionPrompt } from "../src/memory/prompts/l1-extraction.js";
import "dotenv/config";

async function testExtraction() {
  const engine = new MemoryEngine();
  // @ts-ignore - access private for testing
  const runner = engine.llmRunner;

  const newMessages = [
    {
      id: "test_msg_1",
      userId: "test",
      sessionKey: "test",
      sessionId: "test",
      role: "user",
      messageText: "I want to use Vitest for all unit testing in this project. It's much faster than Jest.",
      recordedAt: new Date().toISOString(),
      timestamp: Date.now(),
      skillTag: ""
    }
  ];

  const prompt = formatExtractionPrompt({ newMessages });

  console.log("--- PROMPT ---");
  console.log(prompt);
  console.log("\n--- SYSTEM PROMPT ---");
  console.log(EXTRACT_MEMORIES_SYSTEM_PROMPT);

  try {
    const result = await runner.run({
      prompt,
      systemPrompt: EXTRACT_MEMORIES_SYSTEM_PROMPT
    });
    console.log("\n--- RESULT ---");
    console.log(result);
  } catch (err) {
    console.error("LLM Run failed:", err);
  }
}

testExtraction();
