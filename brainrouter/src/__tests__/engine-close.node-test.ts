import test from "node:test";
import assert from "node:assert/strict";
import { MemoryEngine, getMemoryEngine, closeMemoryEngine } from "../memory/engine.js";
import { createTestStore } from "./helpers/pgTestStore.js";

/**
 * LAZY-ENGINE — the memoryEngine singleton is lazy + closeable. close() stops the
 * background timers/job-runner and closes the store pool (idempotent), which is
 * what lets the integration suite exit without --test-force-exit.
 */

test("MemoryEngine.close() closes the store pool and is idempotent", async () => {
  const { store, cleanup } = await createTestStore();
  const engine = new MemoryEngine(store);
  await engine.ready;

  await engine.close();
  // pool is closed → any query rejects rather than hanging
  await assert.rejects(() => store.getCoreIdentity("u1"), /pool|end/i);
  // second close is a no-op (does not throw "called end on pool more than once")
  await engine.close();

  await cleanup().catch(() => undefined); // store already closed; cleanup tolerates it + drops the scratch DB
});

test("closeMemoryEngine() is a no-op when the singleton was never constructed", async () => {
  // Nothing has touched getMemoryEngine() in this fresh process → must not throw.
  await closeMemoryEngine();
});

test("getMemoryEngine() returns a stable instance; closeMemoryEngine() drops it", async () => {
  const a = getMemoryEngine();
  const b = getMemoryEngine();
  assert.equal(a, b); // same lazily-built singleton
  await closeMemoryEngine(); // closes (awaits init) + drops
  const c = getMemoryEngine();
  assert.notEqual(c, a); // a fresh instance after a close
  await closeMemoryEngine(); // tidy up the one we just built
});
