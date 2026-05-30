import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offloadWorkingPayload, reclaimWorkingMemory, getWorkingMemoryDir } from "../memory/working/offload.js";

function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "brainrouter-reclaim-"));
  const prev = process.env.HOME;
  process.env.HOME = home; // working-memory dir lives under home — redirect so the test self-cleans
  try {
    fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("MEM-12 reclaim sweeps orphan refs while protecting active ones", () => {
  withHome((home) => {
    offloadWorkingPayload({ workspacePath: home, userId: "u1", sessionKey: "s1", payload: "a real offloaded payload ".repeat(20), forceAggressive: true });
    const workDir = getWorkingMemoryDir(home, "u1", "s1");
    // an orphan ref the step log doesn't reference (e.g. left behind after log compression)
    fs.writeFileSync(join(workDir, "refs", "orphanXYZ.md"), "stale orphan content", "utf8");

    const r = reclaimWorkingMemory(home, "u1", "s1");
    assert.equal(r.reclaimed, 1, "the orphan is reclaimed");
    assert.ok(r.keptActive >= 1, "the active ref is protected");
    assert.ok(r.reclaimedNodeIds.includes("orphanXYZ"));
    assert.ok(!fs.existsSync(join(workDir, "refs", "orphanXYZ.md")), "orphan file deleted");
    assert.ok(r.bytesFreed > 0);
  });
});

test("MEM-12 retention window keeps orphans newer than maxAgeMs", () => {
  withHome((home) => {
    offloadWorkingPayload({ workspacePath: home, userId: "u1", sessionKey: "s1", payload: "payload ".repeat(20), forceAggressive: true });
    const workDir = getWorkingMemoryDir(home, "u1", "s1");
    fs.writeFileSync(join(workDir, "refs", "freshOrphan.md"), "just made", "utf8");
    // The orphan was created milliseconds ago → far younger than a 60s window → kept.
    const r = reclaimWorkingMemory(home, "u1", "s1", { maxAgeMs: 60_000 });
    assert.equal(r.reclaimed, 0, "recent orphan within retention is kept");
    assert.ok(fs.existsSync(join(workDir, "refs", "freshOrphan.md")));
  });
});
