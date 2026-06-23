import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRecallPipeline } from "../memory/recall.js";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { asyncify } from "../memory/store/asyncify.js";

function record(id: string, userId: string, content: string) {
  const now = "2026-06-20T00:00:00.000Z";
  return {
    id,
    userId,
    sessionKey: "session-a",
    sessionId: "",
    content,
    type: "fact",
    priority: 80,
    sceneName: "",
    skillTag: "",
    halfLifeDays: null,
    supersededBy: null,
    timestampStr: now,
    timestampStart: now,
    timestampEnd: now,
    createdTime: now,
    updatedTime: now,
    metadata: {},
    confidence: 1,
    status: "active",
    sourceKind: "user_input",
    verificationStatus: "unverified",
    repoPaths: [],
    filePaths: [],
    commands: [],
    citationCount: 0,
    lastCitedAt: null,
    neverCitedCount: 0,
    archived: false,
  } as any;
}

test("enabled recall compression stores under the caller and leaves the prepend context intact", async () => {
  const previous = new Map([
    ["BRAINROUTER_COMPRESSION_ENABLED", process.env.BRAINROUTER_COMPRESSION_ENABLED],
    ["BRAINROUTER_COMPRESSION_MIN_TOKENS", process.env.BRAINROUTER_COMPRESSION_MIN_TOKENS],
    ["BRAINROUTER_COMPRESSION_TARGET_KEEP", process.env.BRAINROUTER_COMPRESSION_TARGET_KEEP],
  ]);
  const dir = mkdtempSync(join(tmpdir(), "brainrouter-recall-compression-"));
  try {
    process.env.BRAINROUTER_COMPRESSION_ENABLED = "true";
    process.env.BRAINROUTER_COMPRESSION_MIN_TOKENS = "1";
    process.env.BRAINROUTER_COMPRESSION_TARGET_KEEP = "0.2";
    const store = new SqliteMemoryStore(join(dir, "memory.db"));
    store.init();
    const recall = new MemoryRecallPipeline(
      asyncify(store),
      { isReady: () => false } as any,
      { isAvailable: () => false } as any,
    );
    const original = JSON.stringify(Array.from({ length: 80 }, (_, id) => ({ id, message: id === 37 ? "ERROR database failed" : `incident event ${id}` })));
    store.upsertCognitive(record("rec-compress", "u1", original));

    const recalled = await recall.recall({ userId: "u1", sessionKey: "session-a", query: "incident" });
    const compressed = recalled.recalledCognitiveMemories?.find((memory) => memory.recordId === "rec-compress");

    assert.ok(compressed?.content.includes("_ccr_dropped"));
    assert.ok(recalled.prependContext?.includes(original));
    assert.ok(recalled.appendSystemContext?.includes("memory_retrieve"));
    const hash = compressed?.content.match(/<<ccr:([a-f0-9]{24})/)?.[1];
    assert.ok(hash);
    assert.equal(store.retrieveCompressionEntry("u1", hash!)?.originalContent, original);
    assert.equal(store.retrieveCompressionEntry("u2", hash!), null);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
