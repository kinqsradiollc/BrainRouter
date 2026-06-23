import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";
import type { PostgresMemoryStore } from "../memory/store/postgres/PostgresMemoryStore.js";
import { MemoryCapturePipeline } from "../memory/capture.js";
import { redactSensitiveMemoryText } from "../memory/util/redaction.js";
import { contentHash } from "../memory/pipeline/apply-dedup.js";

// extractEveryNTurns set absurdly high so cognitive extraction never fires —
// this isolates the MEM-2′ source-ingest path. The LLM / embedding deps are
// therefore never touched, so trivial stubs suffice.
async function freshPipeline(): Promise<{ store: PostgresMemoryStore; pipe: MemoryCapturePipeline; cleanup: () => Promise<void> }> {
  const { store, cleanup } = await createTestStore();
  const llmStub = (async () => "") as any;
  const embStub = { isReady: () => false, embed: async () => [] } as any;
  const pipe = new MemoryCapturePipeline(store, llmStub, embStub, 99);
  return { store, pipe, cleanup };
}

const TS = 1_700_000_000_000;
const BIG = "This is a substantial user turn that describes the failing test in detail, including the stack trace and the file paths involved, well past the minimum threshold.";

test("MEM-2′ captureTurn ingests a substantial message as a transcript source + chunks", async () => {
  const { store, pipe, cleanup } = await freshPipeline();
  try {
    await pipe.captureTurn({ userId: "u1", sessionKey: "s1", messages: [{ role: "user", content: BIG, timestamp: TS }] });
    const doc = await store.getSourceDocumentByHash("u1", contentHash(redactSensitiveMemoryText(BIG)));
    assert.ok(doc, "a source document was created");
    assert.equal(doc!.kind, "transcript");
    assert.equal(doc!.uri, null);
    assert.deepEqual(doc!.metadata, { sessionKey: "s1", role: "user" });
    const chunks = await store.getSourceChunksByDocument(doc!.id);
    assert.ok(chunks.length >= 1, "the source was chunked");
    assert.ok(chunks.map((c) => c.content).join("\n").includes("stack trace"));
  } finally {
    await cleanup();
  }
});

test("MEM-2′ skips trivial messages (below the char threshold)", async () => {
  const { store, pipe, cleanup } = await freshPipeline();
  try {
    await pipe.captureTurn({ userId: "u1", sessionKey: "s1", messages: [{ role: "user", content: "hi, thanks!", timestamp: TS }] });
    assert.ok(!(await store.getSourceDocumentByHash("u1", contentHash(redactSensitiveMemoryText("hi, thanks!")))), "no doc for a trivial turn");
  } finally {
    await cleanup();
  }
});

test("MEM-2′ is idempotent — re-capturing identical content reuses the doc + chunks", async () => {
  const { store, pipe, cleanup } = await freshPipeline();
  try {
    await pipe.captureTurn({ userId: "u1", sessionKey: "s1", messages: [{ role: "user", content: BIG, timestamp: TS }] });
    const doc1 = (await store.getSourceDocumentByHash("u1", contentHash(redactSensitiveMemoryText(BIG))))!;
    const n1 = (await store.getSourceChunksByDocument(doc1.id)).length;
    // Same content again (e.g. a re-run / replay) must not duplicate.
    await pipe.captureTurn({ userId: "u1", sessionKey: "s2", messages: [{ role: "user", content: BIG, timestamp: TS + 5 }] });
    const doc2 = (await store.getSourceDocumentByHash("u1", contentHash(redactSensitiveMemoryText(BIG))))!;
    assert.equal(doc2.id, doc1.id, "same doc reused");
    assert.equal((await store.getSourceChunksByDocument(doc2.id)).length, n1, "chunks not duplicated");
  } finally {
    await cleanup();
  }
});

test("MEM-NONBLOCK captureTurn returns immediately (deferred) and does NOT block on the LLM extraction", async () => {
  const { store, cleanup } = await createTestStore();
  // A HANGING LLM: extraction (extractEveryNTurns=1 → fires this turn) will await
  // it forever. If captureTurn still awaited extraction, this test would hang;
  // because it backgrounds it, captureTurn resolves immediately with "deferred".
  // The never-resolving promise has no active handle, so it can't keep the
  // process alive or write to the (closed) db.
  const hangingLlm = { run: () => new Promise<string>(() => { /* never resolves */ }) } as any;
  const embStub = { isReady: () => false, embed: async () => [] } as any;
  const pipe = new MemoryCapturePipeline(store, hangingLlm, embStub, 1);
  try {
    const result = await Promise.race([
      pipe.captureTurn({ userId: "u1", sessionKey: "s1", messages: [{ role: "user", content: BIG, timestamp: TS }] }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("captureTurn blocked on the LLM extraction")), 3000).unref()),
    ]);
    assert.equal(result.sensoryRecordedCount, 1, "the sensory row was written synchronously");
    assert.equal(result.cognitiveExtractionTriggered, true);
    assert.equal(result.cognitiveExtractionStatus, "deferred", "extraction was backgrounded, not awaited");
  } finally {
    await cleanup();
  }
});
