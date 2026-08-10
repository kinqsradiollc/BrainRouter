/**
 * ADR-035 §6 — the liveness answer, with no clock anywhere in the file.
 *
 * That absence is the assertion. The lease these tests replace could only be
 * exercised by moving a fake clock past a thirty-second threshold, and every
 * defect it had lived in the gap between "the writer stopped" and "the threshold
 * says so". Nothing below advances any clock, because there is no longer an
 * interval in which a dead tab's recording looks alive.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FakeLockOrigin } from "./_captureLockFixture";
import {
  browserCaptureLocks,
  CaptureLocks,
  captureLockName,
  captureLockSessionId,
} from "./captureLock";

/**
 * One turn of the queue, so a release reaches the browser's own table.
 *
 * Releasing is resolving the promise the lock's lifetime hangs from, and the
 * browser drops it a tick later — in the real API and here. `holds()` is exact
 * immediately because that answer is this tab's own; `query()` is not, and
 * pretending otherwise in a test would be pretending about the API.
 */
const settled = (): Promise<void> => new Promise((resolve) => {
  setImmediate(resolve);
});

test("a second tab is refused at once, and never queued behind the first", async () => {
  const origin = new FakeLockOrigin();
  const first = new CaptureLocks(origin.tab());
  const second = new CaptureLocks(origin.tab());

  assert.equal(await first.hold("mtg-1"), "held");
  // Resolved, not pending: a request that queued would settle in the middle of
  // the other tab's meeting, and Record would appear to hang until then.
  assert.equal(await second.hold("mtg-1"), "taken");
  assert.equal(first.holds("mtg-1"), true);
  assert.equal(second.holds("mtg-1"), false, "a refusal leaves nothing behind to release");
});

test("§6 — a KILLED tab's lock is released by the browser, with no threshold to wait out", async () => {
  const origin = new FakeLockOrigin();
  const tab = origin.tab();
  const killed = new CaptureLocks(tab);
  assert.equal(await killed.hold("mtg-1"), "held");

  // The kill. No Stop, no teardown, no heartbeat, and — the point — no elapsed
  // time: the tab is gone and the browser has already dropped what it held.
  tab.kill();

  const reopened = new CaptureLocks(origin.tab());
  assert.equal(await reopened.hold("mtg-1"), "held", "the recording is available on the very first ask");
  assert.deepEqual([...(await reopened.writers()).ids], ["mtg-1"]);
});

test("a holder cannot be robbed, however long it is frozen", async () => {
  // The lease's other failure: a live tab whose timers were clamped looked dead
  // and had its recording taken. There is no such state here — held is held.
  const origin = new FakeLockOrigin();
  const recording = new CaptureLocks(origin.tab());
  await recording.hold("mtg-1");
  const other = new CaptureLocks(origin.tab());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await other.hold("mtg-1"), "taken");
  }
  assert.equal(recording.holds("mtg-1"), true);
});

test("the writer set names every capture any tab is writing, ours included", async () => {
  const origin = new FakeLockOrigin();
  const first = new CaptureLocks(origin.tab());
  const second = new CaptureLocks(origin.tab());
  await first.hold("mtg-1");
  await second.hold("mtg-2");

  const seen = await second.writers();
  assert.equal(seen.known, true);
  assert.deepEqual([...seen.ids].sort(), ["mtg-1", "mtg-2"]);
  // …and a released one stops being in it, which is what makes a stopped
  // recording offerable to the next tab immediately.
  first.release("mtg-1");
  await settled();
  assert.deepEqual([...(await second.writers()).ids], ["mtg-2"]);
});

test("releasing what we never held changes nothing, and asking twice for our own is not a refusal", async () => {
  const origin = new FakeLockOrigin();
  const locks = new CaptureLocks(origin.tab());
  locks.release("mtg-nothing");
  assert.equal(await locks.hold("mtg-1"), "held");
  // Without the re-entrancy check this answers "taken" — a tab reporting itself
  // as another tab, which is the four-guards defect in its last hat.
  assert.equal(await locks.hold("mtg-1"), "held");
  locks.releaseAll();
  assert.equal(locks.holds("mtg-1"), false);
  await settled();
  assert.deepEqual(origin.names, [], "the browser's table is clear, so another tab can record");
});

test("golden rule 23 — a browser with no Web Locks says it cannot tell, not that nobody is writing", async () => {
  const locks = new CaptureLocks(null);
  assert.equal(locks.available, false);
  assert.equal(await locks.hold("mtg-1"), "unavailable");
  const seen = await locks.writers();
  assert.equal(seen.known, false, "an empty set here would read as 'the device is idle' and reap a live recording");
  assert.deepEqual([...seen.ids], []);
});

test("a lock service that will not answer is unknown, not empty — and still names our own", async () => {
  const origin = new FakeLockOrigin();
  const tab = origin.tab();
  const locks = new CaptureLocks(tab);
  await locks.hold("mtg-mine");
  tab.failQuery = true;
  const seen = await locks.writers();
  assert.equal(seen.known, false);
  assert.deepEqual([...seen.ids], ["mtg-mine"], "what we are holding is a fact, not a question");
});

test("the lock name is namespaced, and another product's lock is not a recording", () => {
  assert.equal(captureLockSessionId(captureLockName("mtg-1")), "mtg-1");
  for (const foreign of [undefined, "", "some-other-app", "brainrouter:meeting-capture:"]) {
    assert.equal(captureLockSessionId(foreign), null, `${String(foreign)} is not a capture`);
  }
});

test("the browser wrapper detects the API rather than assuming it", () => {
  // This runner has a `navigator` and no `navigator.locks`, which is also what a
  // dashboard served over plain http gets. Assuming the API here is how the
  // fallback becomes silent.
  assert.equal(browserCaptureLocks().available, false);
});
