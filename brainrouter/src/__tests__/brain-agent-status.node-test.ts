/**
 * BRAIN-P1-T5 (0.4.1) — buildBrainAgentStatuses (shared by the
 * memory_agent_status tool + GET /api/brain/agents dashboard route).
 *
 * Real store (Postgres scratch DB) → node --test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";
import { buildBrainAgentStatuses } from "../memory/agents/status.js";
import { listBrainAgents } from "../memory/agents/registry.js";

test("returns every registry agent, idle when no jobs have run", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const statuses = await buildBrainAgentStatuses(store);
    assert.equal(statuses.length, listBrainAgents().length);
    const extractor = statuses.find((s) => s.id === "cognitive_extractor")!;
    assert.equal(extractor.lastJobStatus, "idle");
    assert.equal(extractor.pendingJobs, 0);
    assert.equal(extractor.successRate24h, null);
  } finally {
    await cleanup();
  }
});

test("reflects a pending job and supports an agentId filter", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.enqueueMemoryJob({ kind: "cognitive_extractor", input: { sensoryIds: ["s1"] } });
    const all = await buildBrainAgentStatuses(store);
    const extractor = all.find((s) => s.id === "cognitive_extractor")!;
    assert.equal(extractor.lastJobStatus, "pending");
    assert.equal(extractor.pendingJobs, 1);

    const filtered = await buildBrainAgentStatuses(store, "cognitive_extractor");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "cognitive_extractor");
  } finally {
    await cleanup();
  }
});
