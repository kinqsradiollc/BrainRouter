import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";
import { buildSkillExtractionPrompt, parseSkillResponse, NO_SKILL_SENTINEL } from "../memory/skill-extract.js";

function fresh(label: string): { engine: MemoryEngine; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-mem33-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { engine: new MemoryEngine(store), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("MEM-33 parseSkillResponse: gate on <no-skill/>, empty, single-line; accept a real SOP", () => {
  assert.equal(parseSkillResponse(NO_SKILL_SENTINEL).skill, null);
  assert.equal(parseSkillResponse("  <NO-SKILL/>  ").skill, null);
  assert.equal(parseSkillResponse("").skill, null);
  assert.equal(parseSkillResponse("just one short line").skill, null); // no steps
  const sop = "Release a patch\n1. Bump version\n2. Run tests\n3. Tag + publish";
  assert.equal(parseSkillResponse(sop).skill, sop);
  // code fences stripped
  assert.equal(parseSkillResponse("```\n" + sop + "\n```").skill, sop);
});

test("MEM-33 buildSkillExtractionPrompt: includes the summary + the no-skill instruction", () => {
  const { system, user } = buildSkillExtractionPrompt("did X then Y then verified Z");
  assert.match(user, /did X then Y/);
  assert.match(system, /<no-skill\/>/);
  assert.match(user, /<no-skill\/>/);
});

test("MEM-33 extractSkillFromSession: <no-skill/> stores nothing; a real SOP is stored as a reinforcing lesson", async () => {
  const { engine, cleanup } = fresh("extract");
  try {
    const summary = "Investigated a flaky test, found a race in the worker pool, added a barrier, and verified 100 runs green.";
    // Exploratory → no skill.
    const none = await engine.extractSkillFromSession("u1", { sessionSummary: summary, llm: async () => NO_SKILL_SENTINEL });
    assert.equal(none.extracted, false);

    // Real SOP.
    const sop = "Fix a flaky concurrency test\n1. Reproduce under load\n2. Localize the shared-state race\n3. Add a barrier/lock\n4. Verify N runs green";
    const got = await engine.extractSkillFromSession("u1", { sessionSummary: summary, llm: async () => sop });
    assert.equal(got.extracted, true);
    assert.equal(got.skill, sop);
    assert.equal(got.reinforced, false, "first extraction creates");
    assert.ok(got.recordId);

    // Re-extracting the same SOP reinforces (reuses MEM-32), no duplicate.
    const again = await engine.extractSkillFromSession("u1", { sessionSummary: summary, llm: async () => sop });
    assert.equal(again.extracted, true);
    assert.equal(again.reinforced, true);
    assert.equal(again.recordId, got.recordId);
  } finally { cleanup(); }
});

test("MEM-33 extractSkillFromSession: LLM failure is best-effort (stores nothing, no throw)", async () => {
  const { engine, cleanup } = fresh("llmfail");
  try {
    const r = await engine.extractSkillFromSession("u1", {
      sessionSummary: "a long enough summary of a session that did several things and verified them",
      llm: async () => { throw new Error("LLM down"); },
    });
    assert.equal(r.extracted, false);
  } finally { cleanup(); }
});
