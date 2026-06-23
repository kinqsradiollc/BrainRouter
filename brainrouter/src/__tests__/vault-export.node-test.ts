import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine } from "../memory/engine.js";
import { createTestEngine } from "./helpers/pgTestStore.js";

async function fresh(label: string): Promise<{ engine: MemoryEngine; vault: string; cleanup: () => Promise<void> }> {
  // The DB lives in Postgres now; this temp dir only holds the exported vault.
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-vault-${label}-`));
  const { engine, cleanup } = await createTestEngine();
  return {
    engine,
    vault: join(dir, "vault"),
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
      await cleanup();
    },
  };
}

test("MEM-7 exportVault writes markdown + ledger, then re-export is idempotent", async () => {
  const { engine, vault, cleanup } = await fresh("idem");
  try {
    const rec = await engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content: "Recall uses RRF fusion." });
    await engine.appendTreeLeaf("u1", "source", "A leaf summary", []);

    const first = await engine.exportVault("u1", vault);
    assert.ok(first.written >= 2, "record + tree leaf written");
    assert.equal(first.unchanged, 0);
    assert.ok(existsSync(join(vault, "records", `${rec.id}.md`)), "record file exists");
    assert.match(readFileSync(join(vault, "records", `${rec.id}.md`), "utf8"), /Recall uses RRF fusion\./);

    // Re-export with no DB changes → everything unchanged, nothing rewritten.
    const second = await engine.exportVault("u1", vault);
    assert.equal(second.written, 0, "idempotent: no rewrites");
    assert.equal(second.unchanged, first.written);
  } finally { await cleanup(); }
});

test("MEM-7 vault content is redacted (MEM-13 vault boundary)", async () => {
  const { engine, vault, cleanup } = await fresh("redact");
  try {
    const rec = await engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content: "key sk-abcdef1234567890zzzz leaked" });
    await engine.exportVault("u1", vault);
    const md = readFileSync(join(vault, "records", `${rec.id}.md`), "utf8");
    assert.ok(md.includes("[REDACTED]"));
    assert.ok(!md.includes("sk-abcdef"));
  } finally { await cleanup(); }
});
