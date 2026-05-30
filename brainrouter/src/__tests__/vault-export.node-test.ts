import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

function fresh(label: string): { engine: MemoryEngine; vault: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-vault-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { engine: new MemoryEngine(store), vault: join(dir, "vault"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("MEM-7 exportVault writes markdown + ledger, then re-export is idempotent", () => {
  const { engine, vault, cleanup } = fresh("idem");
  try {
    const rec = engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content: "Recall uses RRF fusion." });
    engine.appendTreeLeaf("u1", "source", "A leaf summary", []);

    const first = engine.exportVault("u1", vault);
    assert.ok(first.written >= 2, "record + tree leaf written");
    assert.equal(first.unchanged, 0);
    assert.ok(existsSync(join(vault, "records", `${rec.id}.md`)), "record file exists");
    assert.match(readFileSync(join(vault, "records", `${rec.id}.md`), "utf8"), /Recall uses RRF fusion\./);

    // Re-export with no DB changes → everything unchanged, nothing rewritten.
    const second = engine.exportVault("u1", vault);
    assert.equal(second.written, 0, "idempotent: no rewrites");
    assert.equal(second.unchanged, first.written);
  } finally { cleanup(); }
});

test("MEM-7 vault content is redacted (MEM-13 vault boundary)", () => {
  const { engine, vault, cleanup } = fresh("redact");
  try {
    const rec = engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content: "key sk-abcdef1234567890zzzz leaked" });
    engine.exportVault("u1", vault);
    const md = readFileSync(join(vault, "records", `${rec.id}.md`), "utf8");
    assert.ok(md.includes("[REDACTED]"));
    assert.ok(!md.includes("sk-abcdef"));
  } finally { cleanup(); }
});
