/**
 * ADR-027 D11 / P1-6 — retention and compaction, against a real Postgres.
 *
 * The property that matters is not "old rows disappear" — that is easy and
 * useless. It is that **nothing reported is lost**: the aggregate a dashboard
 * reads must equal the sum of the raw rows that were dropped to produce it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";
import {
  compactJobProgress,
  rollUpModelUsage,
} from "../memory/store/postgres/queries/retentionQueries.js";

type Exec = Parameters<typeof rollUpModelUsage>[0];
function execOf(store: unknown): Exec {
  return (store as { exec: Exec }).exec;
}

/** The rollup is org-scoped by FK, so a real organization must exist. */
async function seedOrg(exec: Exec, orgId: string): Promise<void> {
  await exec.run(
    `INSERT INTO organizations (org_id, name, slug, created_at)
     VALUES ($1, $1, $1, now()) ON CONFLICT (org_id) DO NOTHING`,
    [orgId],
  );
}

async function seedUsage(exec: Exec, input: {
  orgId: string; model: string; ageDays: number; tokens: number; cost: number; requestId: string;
}): Promise<void> {
  await exec.run(
    `INSERT INTO model_usage_events
       (request_id, org_id, user_id, public_model_id, input_tokens, output_tokens,
        cached_input_tokens, total_tokens, cost_microusd, created_at)
     VALUES ($1,$2,'u1',$3,$4,$5,0,$6,$7, now() - make_interval(days => $8::int))`,
    [input.requestId, input.orgId, input.model, input.tokens, input.tokens * 2,
      input.tokens * 3, input.cost, input.ageDays],
  );
}

test("usage rollup preserves every reported number while dropping raw rows", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    await seedOrg(exec, "orgA");

    // Three expired requests on the same day+model, plus one still inside the
    // window that must be left completely alone.
    for (const [i, tokens] of [10, 20, 30].entries()) {
      await seedUsage(exec, { orgId: "orgA", model: "m1", ageDays: 120, tokens, cost: tokens * 100, requestId: `old-${i}` });
    }
    await seedUsage(exec, { orgId: "orgA", model: "m1", ageDays: 3, tokens: 999, cost: 1, requestId: "recent" });

    const folded = await rollUpModelUsage(exec, { retentionDays: 90 });
    assert.equal(folded, 3, "only the expired rows are folded");

    const remaining = await exec.rows<{ request_id: string }>("SELECT request_id FROM model_usage_events");
    assert.deepEqual(remaining.map((r) => r.request_id), ["recent"], "in-window detail is untouched");

    const daily = await exec.one<Record<string, unknown>>(
      "SELECT requests, input_tokens, output_tokens, total_tokens, cost_microusd FROM model_usage_daily WHERE org_id = $1",
      ["orgA"],
    );
    assert.ok(daily);
    assert.equal(Number(daily.requests), 3);
    assert.equal(Number(daily.input_tokens), 60, "10+20+30");
    assert.equal(Number(daily.output_tokens), 120, "double each");
    assert.equal(Number(daily.cost_microusd), 6_000, "1000+2000+3000");
  } finally {
    await cleanup();
  }
});

test("a second pass accumulates into the same day rather than overwriting it", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    await seedOrg(exec, "orgA");

    await seedUsage(exec, { orgId: "orgA", model: "m1", ageDays: 120, tokens: 5, cost: 100, requestId: "a" });
    assert.equal(await rollUpModelUsage(exec, { retentionDays: 90 }), 1);

    // A late-arriving row for the same expired day, folded on a later pass.
    await seedUsage(exec, { orgId: "orgA", model: "m1", ageDays: 120, tokens: 7, cost: 200, requestId: "b" });
    assert.equal(await rollUpModelUsage(exec, { retentionDays: 90 }), 1);

    const daily = await exec.one<Record<string, unknown>>(
      "SELECT requests, input_tokens, cost_microusd FROM model_usage_daily WHERE org_id = $1", ["orgA"],
    );
    assert.equal(Number(daily!.requests), 2, "counts add, they do not replace");
    assert.equal(Number(daily!.input_tokens), 12);
    assert.equal(Number(daily!.cost_microusd), 300);
  } finally {
    await cleanup();
  }
});

test("rollup separates orgs and models instead of merging them", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    await seedOrg(exec, "orgA");
    await seedOrg(exec, "orgB");

    await seedUsage(exec, { orgId: "orgA", model: "m1", ageDays: 120, tokens: 1, cost: 10, requestId: "a1" });
    await seedUsage(exec, { orgId: "orgA", model: "m2", ageDays: 120, tokens: 2, cost: 20, requestId: "a2" });
    await seedUsage(exec, { orgId: "orgB", model: "m1", ageDays: 120, tokens: 4, cost: 40, requestId: "b1" });

    assert.equal(await rollUpModelUsage(exec, { retentionDays: 90 }), 3);
    const rows = await exec.rows<Record<string, unknown>>(
      "SELECT org_id, public_model_id, input_tokens FROM model_usage_daily ORDER BY org_id, public_model_id",
    );
    assert.equal(rows.length, 3, "one row per (day, org, model)");
    assert.deepEqual(rows.map((r) => `${r.org_id}/${r.public_model_id}/${r.input_tokens}`),
      ["orgA/m1/1", "orgA/m2/2", "orgB/m1/4"]);
  } finally {
    await cleanup();
  }
});

test("the batch bound limits a single pass and successive passes drain the rest", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    await seedOrg(exec, "orgA");
    for (let i = 0; i < 5; i++) {
      await seedUsage(exec, { orgId: "orgA", model: "m1", ageDays: 120, tokens: 1, cost: 1, requestId: `r${i}` });
    }

    assert.equal(await rollUpModelUsage(exec, { retentionDays: 90, batchSize: 2 }), 2);
    assert.equal(await rollUpModelUsage(exec, { retentionDays: 90, batchSize: 2 }), 2);
    assert.equal(await rollUpModelUsage(exec, { retentionDays: 90, batchSize: 2 }), 1);
    assert.equal(await rollUpModelUsage(exec, { retentionDays: 90, batchSize: 2 }), 0);

    const daily = await exec.one<Record<string, unknown>>(
      "SELECT requests FROM model_usage_daily WHERE org_id = $1", ["orgA"],
    );
    assert.equal(Number(daily!.requests), 5, "batching must not lose or double-count");
  } finally {
    await cleanup();
  }
});

test("job progress compacts to a marker that records what was dropped", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    const job = await store.enqueueMemoryJob({ kind: "k", input: {} });
    await store.startMemoryJob(job.id);
    for (let i = 0; i < 4; i++) {
      await store.appendJobProgress(job.id, { ts: new Date(Date.now() + i).toISOString(), kind: "step", msg: `event ${i}` });
    }
    await store.completeMemoryJob(job.id, { ok: true });
    await exec.run("UPDATE memory_jobs SET updated_at = $1 WHERE id = $2",
      [new Date(Date.now() - 120 * 86_400_000).toISOString(), job.id]);

    assert.equal(await compactJobProgress(exec, { retentionDays: 90 }), 1);

    const after = (await store.getMemoryJob(job.id))!;
    assert.equal(after.status, "done", "the job row itself survives");
    assert.deepEqual(after.output, { ok: true }, "output is not touched");
    assert.equal(after.progress.length, 1);
    assert.equal(after.progress[0]!.kind, "compacted");
    assert.match(after.progress[0]!.msg, /4 progress events compacted after 90 days/);
    assert.equal((after.progress[0]!.data as { originalEvents: number }).originalEvents, 4);
  } finally {
    await cleanup();
  }
});

test("compaction skips in-window jobs, running jobs, and already-compacted rows", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    const age = async (id: string) => exec.run(
      "UPDATE memory_jobs SET updated_at = $1 WHERE id = $2",
      [new Date(Date.now() - 120 * 86_400_000).toISOString(), id]);
    const addEvents = async (id: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await store.appendJobProgress(id, { ts: new Date().toISOString(), kind: "step", msg: `e${i}` });
      }
    };

    // Old but STILL RUNNING — a live job's timeline must not be rewritten.
    const running = await store.enqueueMemoryJob({ kind: "k", input: {} });
    await store.startMemoryJob(running.id);
    await addEvents(running.id, 3);
    await age(running.id);

    // Terminal but INSIDE the window.
    const recent = await store.enqueueMemoryJob({ kind: "k", input: {} });
    await store.startMemoryJob(recent.id);
    await addEvents(recent.id, 3);
    await store.completeMemoryJob(recent.id, { ok: true });

    // Old, terminal, already down to a single event — nothing left to compact,
    // so it must not be rewritten every pass forever.
    const single = await store.enqueueMemoryJob({ kind: "k", input: {} });
    await store.startMemoryJob(single.id);
    await addEvents(single.id, 1);
    await store.completeMemoryJob(single.id, { ok: true });
    await age(single.id);

    assert.equal(await compactJobProgress(exec, { retentionDays: 90 }), 0);
    assert.equal((await store.getMemoryJob(running.id))!.progress.length, 3);
    assert.equal((await store.getMemoryJob(recent.id))!.progress.length, 3);
    assert.equal((await store.getMemoryJob(single.id))!.progress.length, 1);
  } finally {
    await cleanup();
  }
});

test("compaction is idempotent — a second pass finds nothing to do", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const exec = execOf(store);
    const job = await store.enqueueMemoryJob({ kind: "k", input: {} });
    await store.startMemoryJob(job.id);
    for (let i = 0; i < 3; i++) {
      await store.appendJobProgress(job.id, { ts: new Date().toISOString(), kind: "step", msg: `e${i}` });
    }
    await store.completeMemoryJob(job.id, { ok: true });
    await exec.run("UPDATE memory_jobs SET updated_at = $1 WHERE id = $2",
      [new Date(Date.now() - 120 * 86_400_000).toISOString(), job.id]);

    assert.equal(await compactJobProgress(exec, { retentionDays: 90 }), 1);
    assert.equal(await compactJobProgress(exec, { retentionDays: 90 }), 0,
      "a compacted row is down to one event and no longer qualifies");
  } finally {
    await cleanup();
  }
});
