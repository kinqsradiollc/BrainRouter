import { describe, expect, it } from "vitest";
import { extractCognitiveMemories } from "../memory/pipeline/cognitive-extractor.js";
import type { LLMRunner, SensoryRecord } from "@kinqs/brainrouter-types";

function makeMessage(messageText: string): SensoryRecord {
  const recordedAt = new Date().toISOString();
  return {
    id: "sensory_test",
    userId: "user_test",
    sessionKey: "session_test",
    sessionId: "session_test",
    role: "user",
    messageText,
    recordedAt,
    timestamp: Date.parse(recordedAt),
    skillTag: "",
  };
}

function makeRunner(raw: string): LLMRunner {
  return {
    run: async () => raw,
  };
}

function memory(content: string): string {
  return `{
    "type": "episodic",
    "content": "${content}",
    "priority": 50,
    "sourceKind": "model_inference",
    "verificationStatus": "unverified"
  }`;
}

async function extractContents(raw: string): Promise<string[]> {
  const result = await extractCognitiveMemories({
    messages: [makeMessage("capture these paths")],
    userId: "user_test",
    sessionKey: "session_test",
    sessionId: "session_test",
    llmRunner: makeRunner(raw),
  });

  expect(result.success).toBe(true);
  return result.records.map((record) => record.content);
}

describe("cognitive extractor JSON escape repair", () => {
  it("round-trips ambiguous path backslashes without interpreting them as escapes", async () => {
    const raw = String.raw`[
      {
        "scene_name": "Path repair",
        "memories": [
          ${memory(String.raw`C:\users\file`)},
          ${memory(String.raw`C:\bin\node.exe`)},
          ${memory(String.raw`/repos/\target/release`)},
          ${memory(String.raw`\release\foo.txt`)},
          ${memory(String.raw`line1\nline2`)}
        ]
      }
    ]`;

    await expect(extractContents(raw)).resolves.toEqual([
      String.raw`C:\users\file`,
      String.raw`C:\bin\node.exe`,
      String.raw`/repos/\target/release`,
      String.raw`\release\foo.txt`,
      String.raw`line1\nline2`,
    ]);
  });

  it("keeps legitimate JSON escapes on the happy path", async () => {
    const raw = String.raw`[
      {
        "scene_name": "Happy path",
        "memories": [
          ${memory(String.raw`line1\nline2`)}
        ]
      }
    ]`;

    await expect(extractContents(raw)).resolves.toEqual(["line1\nline2"]);
  });
});
