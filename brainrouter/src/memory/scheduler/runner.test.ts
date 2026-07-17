import { describe, expect, it, vi } from "vitest";
import type { IMemoryStore, MemoryJobRecord } from "@kinqs/brainrouter-types";
import { MemoryJobRunner, readJobConcurrency, readJobTenantConcurrency } from "./runner.js";

function jobRecord(id: string, kind = "identity_distiller", input: unknown = { userId: id }): MemoryJobRecord {
  return {
    id, kind, status: "running", priority: 50, attempts: 0, maxAttempts: 1,
    runAfter: "2026-01-01T00:00:00.000Z", lockedAt: "2026-01-01T00:00:00.000Z", parentJobId: null,
    input, output: null, progress: [], error: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as MemoryJobRecord;
}

/** Minimal in-memory store exposing only what the runner touches. */
function fakeStore(queue: MemoryJobRecord[]) {
  const claimCalls: Array<{ perTenantLimit?: number }> = [];
  const completed: Array<{ id: string; output: unknown }> = [];
  const store = {
    sweepStuckMemoryJobs: vi.fn(async () => 0),
    claimNextMemoryJob: vi.fn(async (opts?: { now?: string; perTenantLimit?: number }) => {
      claimCalls.push({ perTenantLimit: opts?.perTenantLimit });
      return queue.shift() ?? null;
    }),
    completeMemoryJob: vi.fn(async (id: string, output: unknown) => { completed.push({ id, output }); return null; }),
    appendJobProgress: vi.fn(async () => undefined),
    getMemoryJob: vi.fn(async () => null),
    failMemoryJob: vi.fn(async () => null),
    cancelMemoryJob: vi.fn(async () => null),
  };
  return { store: store as unknown as IMemoryStore, claimCalls, completed, spies: store };
}

const ctx = (store: IMemoryStore) => ({ store, llmRunner: { run: async () => "" } as any });

describe("MemoryJobRunner — concurrent per-tenant drain", () => {
  it("drains every eligible job in one pass, running them concurrently", async () => {
    const jobs = Array.from({ length: 5 }, (_, i) => jobRecord(`j${i}`));
    const { store, completed } = fakeStore(jobs);

    let active = 0;
    let maxActive = 0;
    const runner = new MemoryJobRunner(store, ctx(store), {
      maxPerTick: 10,
      resolveExecutor: () => async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { ok: true };
      },
    });

    await runner.tick();

    expect(completed.map((c) => c.id).sort()).toEqual(["j0", "j1", "j2", "j3", "j4"]);
    expect(maxActive).toBeGreaterThan(1); // ran in parallel, not one-at-a-time
  });

  it("passes the per-tenant limit to every claim, and stops when the queue drains", async () => {
    const { store, claimCalls } = fakeStore([jobRecord("a"), jobRecord("b")]);
    const runner = new MemoryJobRunner(store, ctx(store), {
      maxPerTick: 10,
      perTenantLimit: 4,
      resolveExecutor: () => async () => ({ ok: true }),
    });

    await runner.tick();

    // Two jobs claimed + one trailing null that ends the drain = 3 claim calls.
    expect(claimCalls).toHaveLength(3);
    expect(claimCalls.every((c) => c.perTenantLimit === 4)).toBe(true);
  });

  it("honors maxPerTick as the global ceiling for one drain", async () => {
    const jobs = Array.from({ length: 5 }, (_, i) => jobRecord(`k${i}`));
    const { store, completed, spies } = fakeStore(jobs);
    const runner = new MemoryJobRunner(store, ctx(store), {
      maxPerTick: 2,
      resolveExecutor: () => async () => ({ ok: true }),
    });

    await runner.tick();

    expect(completed).toHaveLength(2);
    expect(spies.claimNextMemoryJob).toHaveBeenCalledTimes(2); // stopped at the ceiling
  });

  it("perTenantLimit 0 disables the cap (claims with no limit)", async () => {
    const { store, claimCalls } = fakeStore([jobRecord("a")]);
    const runner = new MemoryJobRunner(store, ctx(store), {
      maxPerTick: 4,
      perTenantLimit: 0,
      resolveExecutor: () => async () => ({ ok: true }),
    });
    await runner.tick();
    expect(claimCalls[0]!.perTenantLimit).toBeUndefined();
  });
});

describe("job concurrency env knobs", () => {
  it("readJobConcurrency: default 8, parses + clamps", () => {
    expect(readJobConcurrency({} as NodeJS.ProcessEnv)).toBe(8);
    expect(readJobConcurrency({ BRAINROUTER_JOB_CONCURRENCY: "16" } as unknown as NodeJS.ProcessEnv)).toBe(16);
    expect(readJobConcurrency({ BRAINROUTER_JOB_CONCURRENCY: "999" } as unknown as NodeJS.ProcessEnv)).toBe(64);
    expect(readJobConcurrency({ BRAINROUTER_JOB_CONCURRENCY: "junk" } as unknown as NodeJS.ProcessEnv)).toBe(8);
  });

  it("readJobTenantConcurrency: default 4, parses + clamps", () => {
    expect(readJobTenantConcurrency({} as NodeJS.ProcessEnv)).toBe(4);
    expect(readJobTenantConcurrency({ BRAINROUTER_JOB_TENANT_CONCURRENCY: "2" } as unknown as NodeJS.ProcessEnv)).toBe(2);
    expect(readJobTenantConcurrency({ BRAINROUTER_JOB_TENANT_CONCURRENCY: "  " } as unknown as NodeJS.ProcessEnv)).toBe(4);
  });
});
