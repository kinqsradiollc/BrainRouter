/**
 * ADR-027 D12 (P1-5) — bounded wait queues with age-based shedding.
 *
 * The queue used to be unbounded and strictly FIFO, which fails twice under
 * sustained overload: memory and latency grow without limit, and a freed slot
 * can be handed to a caller whose own deadline expired minutes ago while a
 * fresh caller waits behind it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SemaphoreOverloadError,
  acquireLLMSlot,
  getSemaphoreState,
  resetSemaphoreForTests,
} from "./llm-semaphore.js";

const saved = { ...process.env };

beforeEach(() => {
  process.env.BRAINROUTER_LLM_MAX_CONCURRENT = "1";
  resetSemaphoreForTests();
});

afterEach(() => {
  resetSemaphoreForTests();
  process.env = { ...saved };
});

/** Swallow the rejection so an intentionally shed waiter is not an unhandled rejection. */
function quiet<T>(p: Promise<T>): Promise<T | Error> {
  return p.catch((e: Error) => e);
}

describe("wait queue bounds", () => {
  it("rejects a new arrival once the queue is full instead of growing", async () => {
    process.env.BRAINROUTER_LLM_MAX_QUEUE = "2";

    const held = await acquireLLMSlot();          // occupies the only slot
    const first = quiet(acquireLLMSlot());        // queued 1
    const second = quiet(acquireLLMSlot());       // queued 2
    await Promise.resolve();

    expect(getSemaphoreState().queued).toBe(2);

    // Third arrival exceeds the bound and is rejected immediately.
    await expect(acquireLLMSlot()).rejects.toBeInstanceOf(SemaphoreOverloadError);
    expect(getSemaphoreState().queued).toBe(2);

    held();
    expect(await first).toBeInstanceOf(Function);
    (await first as () => void)();
    expect(await second).toBeInstanceOf(Function);
    (await second as () => void)();
  });

  it("carries the pool name and depth on the overload error", async () => {
    process.env.BRAINROUTER_LLM_MAX_QUEUE = "1";
    const held = await acquireLLMSlot();
    const queued = quiet(acquireLLMSlot());
    await Promise.resolve();

    const error = await acquireLLMSlot().catch((e: SemaphoreOverloadError) => e);
    expect(error).toBeInstanceOf(SemaphoreOverloadError);
    expect((error as SemaphoreOverloadError).pool).toBe("generative LLM");
    expect((error as SemaphoreOverloadError).queued).toBe(1);
    expect((error as SemaphoreOverloadError).message).toMatch(/saturated/);

    held();
    (await queued as () => void)();
  });
});

describe("age-based shedding", () => {
  it("does not hand a freed slot to a waiter that has already aged out", async () => {
    process.env.BRAINROUTER_LLM_MAX_QUEUE = "8";
    process.env.BRAINROUTER_LLM_MAX_WAIT_MS = "10";

    const held = await acquireLLMSlot();
    const stale = quiet(acquireLLMSlot());
    await Promise.resolve();
    expect(getSemaphoreState().queued).toBe(1);

    // Let the waiter age past the limit, then free the slot.
    await new Promise((r) => setTimeout(r, 30));
    held();

    const outcome = await stale;
    expect(outcome).toBeInstanceOf(SemaphoreOverloadError);
    expect(getSemaphoreState().shed).toBe(1);
    // The slot was NOT consumed by the shed waiter — it is available again.
    expect(getSemaphoreState().inFlight).toBe(0);
  });

  it("a fresh waiter still receives the slot after a stale one is shed", async () => {
    process.env.BRAINROUTER_LLM_MAX_QUEUE = "8";
    process.env.BRAINROUTER_LLM_MAX_WAIT_MS = "40";

    const held = await acquireLLMSlot();
    const stale = quiet(acquireLLMSlot());
    await Promise.resolve();

    await new Promise((r) => setTimeout(r, 60));   // `stale` is now past the limit
    const fresh = quiet(acquireLLMSlot());          // enqueued after the cutoff
    await Promise.resolve();

    held();
    expect(await stale).toBeInstanceOf(SemaphoreOverloadError);
    const release = await fresh;
    expect(release).toBeInstanceOf(Function);
    (release as () => void)();
  });

  it("shedding never lets the in-flight count drift", async () => {
    process.env.BRAINROUTER_LLM_MAX_QUEUE = "8";
    process.env.BRAINROUTER_LLM_MAX_WAIT_MS = "10";

    const held = await acquireLLMSlot();
    const shed = [quiet(acquireLLMSlot()), quiet(acquireLLMSlot()), quiet(acquireLLMSlot())];
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));
    held();

    for (const p of shed) expect(await p).toBeInstanceOf(SemaphoreOverloadError);
    const state = getSemaphoreState();
    expect(state.inFlight).toBe(0);
    expect(state.queued).toBe(0);
    expect(state.shed).toBe(3);
  });
});

describe("reset", () => {
  it("rejects pending waiters rather than abandoning them forever", async () => {
    process.env.BRAINROUTER_LLM_MAX_QUEUE = "8";
    await acquireLLMSlot();
    const orphan = quiet(acquireLLMSlot());
    await Promise.resolve();
    expect(getSemaphoreState().queued).toBe(1);

    // Dropping the waiters array on the floor would leave this promise pending
    // forever and hang its caller.
    resetSemaphoreForTests();
    expect(await orphan).toBeInstanceOf(SemaphoreOverloadError);
    expect(getSemaphoreState().queued).toBe(0);
  });
});

describe("an unbounded pool is unaffected", () => {
  it("passes through without queuing when the cap is disabled", async () => {
    process.env.BRAINROUTER_LLM_MAX_CONCURRENT = "0";   // <1 disables the cap
    process.env.BRAINROUTER_LLM_MAX_QUEUE = "1";
    resetSemaphoreForTests();

    const releases = await Promise.all([acquireLLMSlot(), acquireLLMSlot(), acquireLLMSlot()]);
    expect(releases).toHaveLength(3);
    expect(getSemaphoreState().queued).toBe(0);
    for (const release of releases) release();
  });
});
