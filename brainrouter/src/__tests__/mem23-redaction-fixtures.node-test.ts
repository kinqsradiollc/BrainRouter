import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";
import { MemoryCapturePipeline } from "../memory/capture.js";
import { redactSensitiveMemoryText } from "../memory/redaction.js";
import { contentHash } from "../memory/pipeline/apply-dedup.js";

/**
 * MEM-23 (0.4.4) — redaction regression fixtures. Feeds credential-shaped text
 * through each WRITE boundary and asserts the secret never lands in the stored
 * value. Guards against a future change that drops a redact call.
 *
 * Blackboard staging + working-offload preview are covered by
 * mem13-redaction.node-test.ts; this file adds the remaining boundaries:
 * transcript (sensory), source chunks, and the vault export render.
 */

const GH = "ghp_abcdef1234567890abcd";
const SK = "sk-zzzz1234567890wxyz";
const CONN = "postgres://admin:hunter2@db.internal:5432/app";
const IP = "10.1.2.3";
// ≥120 chars so it also ingests as a source document.
const SECRET_MSG =
  `Full deploy runbook for staging. Use ${GH} and ${SK} to authenticate. ` +
  `Connect via ${CONN} and keep the host ${IP} private. ` +
  `Reminder again: ${GH} / ${SK}. Do not leak any of this anywhere, ever.`;

const leaks = (s: string): boolean =>
  s.includes("ghp_abcdef") || s.includes("sk-zzzz") || s.includes("hunter2") || s.includes("10.1.2.3");

function fresh(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `br-mem23-${label}-`));
  const prevRunner = process.env.BRAINROUTER_JOB_RUNNER;
  process.env.BRAINROUTER_JOB_RUNNER = "off";
  const store = new SqliteMemoryStore(join(dir, "m.db"));
  store.init();
  const engine = new MemoryEngine(store);
  return {
    store, engine,
    cleanup: () => {
      if (prevRunner === undefined) delete process.env.BRAINROUTER_JOB_RUNNER;
      else process.env.BRAINROUTER_JOB_RUNNER = prevRunner;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Capture pipeline with a stub LLM + a huge extract interval, so captureTurn
 * writes sensory + source records but never reaches (LLM) extraction. */
function stubPipeline(store: SqliteMemoryStore): MemoryCapturePipeline {
  const llm = { run: async () => "" } as any;
  const embed = { isReady: () => false, embed: async () => [] } as any;
  return new MemoryCapturePipeline(store, llm, embed, 999);
}

test("MEM-23 transcript (sensory) messageText is redacted at capture", async () => {
  const { store, cleanup } = fresh("sensory");
  try {
    await stubPipeline(store).captureTurn({
      userId: "u1",
      sessionKey: "s1",
      messages: [{ role: "user", content: SECRET_MSG, timestamp: 1 }],
    });
    const sensory = store.getRecentSensoryMessages("u1", "s1", 20);
    assert.ok(sensory.length >= 1, "a sensory record was written");
    assert.ok(sensory.every((r) => !leaks(r.messageText)), "no secret in any sensory record");
    assert.ok(sensory.some((r) => r.messageText.includes("[REDACTED")), "redaction marker present");
  } finally {
    cleanup();
  }
});

test("MEM-23 source chunks are redacted at ingest", async () => {
  const { store, cleanup } = fresh("source");
  try {
    await stubPipeline(store).captureTurn({
      userId: "u1",
      sessionKey: "s1",
      messages: [{ role: "user", content: SECRET_MSG, timestamp: 1 }],
    });
    // The source doc is keyed by the hash of the REDACTED turn text.
    const doc = store.getSourceDocumentByHash("u1", contentHash(redactSensitiveMemoryText(SECRET_MSG)));
    assert.ok(doc, "a source document was ingested from the turn");
    const chunks = store.getSourceChunksByDocument(doc!.id);
    assert.ok(chunks.length >= 1, "source chunks exist");
    assert.ok(chunks.every((c) => !leaks(c.content)), "no secret in any source chunk");
  } finally {
    cleanup();
  }
});

test("MEM-23 vault export render redacts record markdown", () => {
  const { engine, cleanup } = fresh("vault");
  const out = mkdtempSync(join(tmpdir(), "br-mem23-vaultout-"));
  try {
    const rec = engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content: SECRET_MSG });
    const res = engine.exportVault("u1", out);
    assert.ok(res.written >= 1, "at least one vault file written");
    const md = readFileSync(join(out, `records/${rec.id}.md`), "utf8");
    assert.ok(!leaks(md), "no secret in the exported markdown");
    assert.ok(md.includes("[REDACTED"), "redaction marker present in the export");
  } finally {
    rmSync(out, { recursive: true, force: true });
    cleanup();
  }
});
