import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";
import { buildReflectPrompt, parseReflectResponse, NO_INSIGHT_SENTINEL } from "../memory/reflect.js";

function fresh(label: string): { engine: MemoryEngine; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-mem32b-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { engine: new MemoryEngine(store), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("MEM-32b parseReflectResponse: bullets extracted; <no-insight/> + empty → none", () => {
  assert.deepEqual(parseReflectResponse(NO_INSIGHT_SENTINEL), []);
  assert.deepEqual(parseReflectResponse(""), []);
  const r = parseReflectResponse("- Tests flake when shared state isn't reset between runs\n- Migrations must run before seeding\n* Cache the tokenizer across calls");
  assert.equal(r.length, 3);
  assert.match(r[0], /flake/);
  // single-sentence fallback
  assert.deepEqual(parseReflectResponse("Always validate config before applying it"), ["Always validate config before applying it"]);
  assert.ok(parseReflectResponse("- x").length === 0, "too-short bullets dropped");
});

test("MEM-32b buildReflectPrompt: numbers the memories + asks for cross-cutting insight", () => {
  const { system, user } = buildReflectPrompt(["mem one about caching", "mem two about caching too"]);
  assert.match(user, /1\. mem one/);
  assert.match(user, /2\. mem two/);
  assert.match(system, /cross-cutting|MULTIPLE/i);
  assert.match(system, /<no-insight\/>/);
});

test("MEM-32b engine.reflect: too few memories → no-op; insights recorded as lessons", async () => {
  const { engine, cleanup } = fresh("engine");
  try {
    // < 3 memories → no-op
    const none = await engine.reflect("u1", { llm: async () => "- something" });
    assert.equal(none.reflected, 0);

    // seed >=3 memories
    for (let i = 0; i < 4; i++) engine.upsertEngineeringMemory({ userId: "u1", type: "codebase_fact", content: `fact ${i} about the cache layer` });
    const got = await engine.reflect("u1", { llm: async () => "- The cache layer is a recurring source of subtle bugs" });
    assert.equal(got.reflected, 1);
    assert.match(got.insights[0], /cache layer/);

    // a <no-insight/> response records nothing
    const empty = await engine.reflect("u1", { llm: async () => NO_INSIGHT_SENTINEL });
    assert.equal(empty.reflected, 0);

    // LLM failure is best-effort
    const failed = await engine.reflect("u1", { llm: async () => { throw new Error("LLM down"); } });
    assert.equal(failed.reflected, 0);
  } finally { cleanup(); }
});
