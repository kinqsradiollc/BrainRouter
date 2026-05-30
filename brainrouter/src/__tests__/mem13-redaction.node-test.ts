import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";
import { offloadWorkingPayload, getWorkingMemoryDir } from "../memory/working/offload.js";
import { readWorkingSteps } from "../memory/working/step-log.js";

const SECRET = "the api key is sk-abcdef1234567890zzzz, do not leak it anywhere";

test("MEM-13 blackboard candidate content is redacted at the staging boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "br-mem13-bb-"));
  try {
    const store = new SqliteMemoryStore(join(dir, "m.db"));
    store.init();
    const engine = new MemoryEngine(store);
    const [staged] = engine.stageBlackboardCandidates("u1", [
      { candidate: { content: SECRET, type: "codebase_fact" }, score: 0.9 },
    ]);
    assert.ok(staged.candidate.content.includes("[REDACTED]"));
    assert.ok(!staged.candidate.content.includes("sk-abcdef"));
    // persisted redacted too
    assert.ok(!store.getBlackboardItem(staged.id)!.candidate.content.includes("sk-abcdef"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MEM-13 offload preview (summary) is redacted before it persists", () => {
  const home = mkdtempSync(join(tmpdir(), "br-mem13-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // working-memory dir lives under home — redirect so the test self-cleans
  try {
    offloadWorkingPayload({ workspacePath: home, userId: "u1", sessionKey: "s1", payload: SECRET, forceAggressive: true });
    const steps = readWorkingSteps(getWorkingMemoryDir(home, "u1", "s1"));
    assert.ok(steps.length >= 1, "a working step was logged");
    assert.ok(steps.some((s) => (s.summary ?? "").includes("[REDACTED]")), "preview redacted");
    assert.ok(!steps.some((s) => (s.summary ?? "").includes("sk-abcdef")), "secret not in any preview");
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
