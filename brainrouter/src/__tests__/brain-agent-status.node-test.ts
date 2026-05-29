/**
 * BRAIN-P1-T5 (0.4.1) — buildBrainAgentStatuses (shared by the
 * memory_agent_status tool + GET /api/brain/agents dashboard route).
 *
 * Real store (node:sqlite) → node --test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { buildBrainAgentStatuses } from "../memory/agents/status.js";
import { listBrainAgents } from "../memory/agents/registry.js";

function freshDb(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-status-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("returns every registry agent, idle when no jobs have run", () => {
  const { store, cleanup } = freshDb("idle");
  try {
    const statuses = buildBrainAgentStatuses(store);
    assert.equal(statuses.length, listBrainAgents().length);
    const extractor = statuses.find((s) => s.id === "cognitive_extractor")!;
    assert.equal(extractor.lastJobStatus, "idle");
    assert.equal(extractor.pendingJobs, 0);
    assert.equal(extractor.successRate24h, null);
  } finally {
    cleanup();
  }
});

test("reflects a pending job and supports an agentId filter", () => {
  const { store, cleanup } = freshDb("pending");
  try {
    store.enqueueMemoryJob({ kind: "cognitive_extractor", input: { sensoryIds: ["s1"] } });
    const all = buildBrainAgentStatuses(store);
    const extractor = all.find((s) => s.id === "cognitive_extractor")!;
    assert.equal(extractor.lastJobStatus, "pending");
    assert.equal(extractor.pendingJobs, 1);

    const filtered = buildBrainAgentStatuses(store, "cognitive_extractor");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "cognitive_extractor");
  } finally {
    cleanup();
  }
});
