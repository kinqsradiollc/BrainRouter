import { describe, expect, it } from "vitest";
import { extractCognitiveMemories } from "../memory/pipeline/cognitive/cognitive-extractor.js";
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

  it("decodes \\uXXXX unicode escapes on the happy path", async () => {
    // The input JSON contains the literal 6-char sequence é (an
    // escape sequence as text). When the JSON is well-formed, the first
    // JSON.parse handles the escape and we get the actual é code point.
    // Locks down the contract for content like "café" / "résumé" /
    // non-ASCII names emitted by LLMs that escape non-ASCII output.
    const raw = String.raw`[
      {
        "scene_name": "Unicode happy",
        "memories": [
          ${memory(String.raw`café done`)}
        ]
      }
    ]`;

    await expect(extractContents(raw)).resolves.toEqual(["café done"]);
  });

  it("preserves \\uXXXX literally when repair fires (paths win the tie-break)", async () => {
    // If anything in the batch forces the repair branch (here: a Windows
    // path with \u + non-hex), then ALL ambiguous backslashes — including
    // otherwise-valid \uXXXX unicode escapes elsewhere in the payload —
    // become literal. Deliberate tradeoff: silent path corruption is
    // worse than a one-off escaped unicode that doesn't decode. The
    // resulting content has a literal `é` (6 chars) instead of "é".
    const raw = String.raw`[
      {
        "scene_name": "Unicode + path collision",
        "memories": [
          ${memory(String.raw`C:\users\file`)},
          ${memory(String.raw`café collateral`)}
        ]
      }
    ]`;

    await expect(extractContents(raw)).resolves.toEqual([
      String.raw`C:\users\file`,
      String.raw`café collateral`,
    ]);
  });

  it("fails extraction instead of consuming sensory rows when the LLM returns empty output", async () => {
    const result = await extractCognitiveMemories({
      messages: [makeMessage("capture this later")],
      userId: "user_test",
      sessionKey: "session_test",
      sessionId: "session_test",
      llmRunner: makeRunner(""),
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("empty response");
  });

  it("fails extraction instead of treating reasoning prose as an empty memory list", async () => {
    const result = await extractCognitiveMemories({
      messages: [makeMessage("capture this later")],
      userId: "user_test",
      sessionKey: "session_test",
      sessionId: "session_test",
      llmRunner: makeRunner("I am still thinking through the extraction task."),
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("non-JSON output");
  });

  it("survives a leaked [user role] chat-template token before the real array (the field bug)", async () => {
    // Reproduces: "Cognitive extraction body invalid … Unexpected token 'u',
    // \"[user role]\"…". The free model leaks a role marker; the old greedy
    // /\[[\s\S]*\]/ matched from THAT bracket and JSON.parse died on `[u`.
    const raw = `[user role] Sure — here is the extraction:\n[{"scene_name":"Auth flow","memories":[${memory("reranker recall fell back to RRF")}]}]`;
    await expect(extractContents(raw)).resolves.toEqual(["reranker recall fell back to RRF"]);
  });

  it("survives prose + a ```json fence around the array", async () => {
    const raw = "Here you go:\n```json\n[{\"scene_name\":\"S\",\"memories\":[" + memory("fenced + prose still parses") + "]}]\n```\nLet me know if you need more.";
    await expect(extractContents(raw)).resolves.toEqual(["fenced + prose still parses"]);
  });

  it("fails extraction (re-queue) when the model returns a bare identifier list", async () => {
    // The headline bug: the model echoes the input sensory IDs as a bare array
    // (`["sensory_7d...", ...]`). It parses to a JSON array but yields zero scene
    // objects. This MUST be a failure so the caller re-queues the rows rather
    // than marking them extracted and dropping them forever.
    const result = await extractCognitiveMemories({
      messages: [makeMessage("capture this later")],
      userId: "user_test",
      sessionKey: "session_test",
      sessionId: "session_test",
      llmRunner: makeRunner('["sensory_7dd3512e", "sensory_e9aa1234"]'),
    });

    expect(result.success).toBe(false);
    expect(result.records).toHaveLength(0);
    expect(result.errorMessage).toContain("no valid scene objects");
  });

  it("fails extraction (re-queue) when the JSON inside the array brackets is unparseable", async () => {
    const result = await extractCognitiveMemories({
      messages: [makeMessage("capture this later")],
      userId: "user_test",
      sessionKey: "session_test",
      sessionId: "session_test",
      llmRunner: makeRunner('[ {"scene_name": "x", "memories": [ }} garbage ]'),
    });

    expect(result.success).toBe(false);
    // The robust extractor (llm-json.ts) returns null for array-like-but-unparseable
    // input, so it re-queues with this reason instead of throwing mid-parse.
    expect(result.errorMessage).toContain("No parseable JSON array");
  });

  it("fails extraction (re-queue) when array items are not scene objects", async () => {
    const result = await extractCognitiveMemories({
      messages: [makeMessage("capture this later")],
      userId: "user_test",
      sessionKey: "session_test",
      sessionId: "session_test",
      llmRunner: makeRunner('[["a","b"],["c"]]'),
    });

    expect(result.success).toBe(false);
    expect(result.records).toHaveLength(0);
  });

  it("treats a genuine empty array as success with zero records (no re-queue)", async () => {
    const result = await extractCognitiveMemories({
      messages: [makeMessage("hi there")],
      userId: "user_test",
      sessionKey: "session_test",
      sessionId: "session_test",
      llmRunner: makeRunner("[]"),
    });

    expect(result.success).toBe(true);
    expect(result.records).toHaveLength(0);
  });

  it("treats valid scenes with empty memories as success, not a parse failure", async () => {
    const result = await extractCognitiveMemories({
      messages: [makeMessage("hi there")],
      userId: "user_test",
      sessionKey: "session_test",
      sessionId: "session_test",
      llmRunner: makeRunner('[{"scene_name":"Trivial chat","memories":[]}]'),
    });

    expect(result.success).toBe(true);
    expect(result.records).toHaveLength(0);
  });
});

describe("cognitive extractor workspace memory tags", () => {
  it("copies durable sensory context into cognitive metadata without replacing model metadata", async () => {
    const raw = `[
      {
        "scene_name": "Workspace context",
        "memories": [
          {
            "type": "codebase_fact",
            "content": "The application uses a shared component library.",
            "priority": 70,
            "sourceKind": "model_inference",
            "verificationStatus": "unverified",
            "metadata": { "source": "turn" }
          }
        ]
      }
    ]`;

    const result = await extractCognitiveMemories({
      messages: [makeMessage("The application uses a shared component library.")],
      userId: "user_test",
      sessionKey: "session_test",
      sessionId: "session_test",
      llmRunner: makeRunner(raw),
      memoryTags: ["engineering", "ui:react"],
    });

    expect(result.success).toBe(true);
    expect(result.records[0]?.metadata).toEqual({
      source: "turn",
      memoryTags: ["engineering", "ui:react"],
    });
  });
});
