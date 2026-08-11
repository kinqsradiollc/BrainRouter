/**
 * ADR-035 D1b — the quota warning has to arrive while a user can still act on it.
 *
 * node:test + tsx, no browser: both the persistence request and the estimate are
 * seams, so what is asserted here is the arithmetic and the wording the user
 * actually sees — not a mock of `navigator.storage` agreeing with itself.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTURE_BUDGET_APPROACHING_MS,
  captureRecordingRate,
  ensureCapturePersistence,
  evaluateCaptureBudget,
  formatCaptureBytes,
  isStorageQuotaError,
} from "./storageBudget";

test("a healthy, persistent origin says nothing", () => {
  const budget = evaluateCaptureBudget({ usageBytes: 10_000_000, quotaBytes: 1_000_000_000, persisted: true });
  assert.equal(budget.level, "ok");
  assert.equal(budget.message, "");
});

test("a full store is recognised however this browser spells it", () => {
  // The recorder stops on this answer, so a miss leaves "■ Stop recording" on
  // screen while nothing is being written — the silent loss, wearing a button.
  assert.equal(isStorageQuotaError(Object.assign(new Error("full"), { name: "QuotaExceededError" })), true);
  assert.equal(isStorageQuotaError(Object.assign(new Error("full"), { name: "NS_ERROR_FILE_NO_DEVICE_SPACE" })), true);
  assert.equal(isStorageQuotaError(Object.assign(new Error("full"), { name: "SomeOldDOMException", code: 22 })), true);
});

test("an ordinary write failure is not mistaken for a full store", () => {
  // Stopping the recording is the right answer to "no more room" and the wrong
  // answer to a transient error, which the next chunk may well survive.
  assert.equal(isStorageQuotaError(new Error("the file handle went away")), false);
  assert.equal(isStorageQuotaError({ code: 22 }), false, "an errno 22 with no DOMException shape is EINVAL");
  assert.equal(isStorageQuotaError(undefined), false);
  assert.equal(isStorageQuotaError("QuotaExceededError"), false);
});

test("a healthy origin WITHOUT persistence still warns, because it can be evicted", () => {
  const budget = evaluateCaptureBudget({ usageBytes: 10_000_000, quotaBytes: 1_000_000_000, persisted: false });
  assert.equal(budget.level, "ok");
  assert.match(budget.message, /persistent storage/);
});

test("the fraction thresholds escalate in order", () => {
  const at = (usage: number) =>
    evaluateCaptureBudget({ usageBytes: usage, quotaBytes: 1_000, persisted: true }).level;
  assert.equal(at(700), "ok");
  assert.equal(at(800), "approaching");
  assert.equal(at(949), "approaching");
  assert.equal(at(950), "critical");
  assert.equal(at(1_000), "exhausted");
  assert.equal(at(1_200), "exhausted");
});

test("a browser that will not report a budget is 'unknown', never 'ok'", () => {
  for (const input of [
    { persisted: true },
    { usageBytes: 10, persisted: true },
    { quotaBytes: 10, persisted: true },
    { usageBytes: 10, quotaBytes: 0, persisted: true },
    { usageBytes: Number.NaN, quotaBytes: 100, persisted: true },
  ]) {
    const budget = evaluateCaptureBudget(input);
    assert.equal(budget.level, "unknown");
    assert.notEqual(budget.message, "", "a degradation nobody can see is a silent outage");
  }
});

test("a known write rate warns on TIME, long before the percentage would", () => {
  // 2% of quota used — no fraction warning at all — but at 1 MB/s the free space
  // is under nine minutes of recording, which is the fact a user can act on.
  const budget = evaluateCaptureBudget({
    usageBytes: 20_000_000,
    quotaBytes: 1_020_000_000,
    persisted: true,
    bytesPerMs: 2_000,
  });
  assert.equal(budget.level, "approaching");
  assert.ok((budget.headroomMs ?? 0) < CAPTURE_BUDGET_APPROACHING_MS);
  assert.match(budget.message, /minutes of recording/);
});

test("the worse of the two signals wins", () => {
  // Comfortable on time, critical on space.
  const budget = evaluateCaptureBudget({
    usageBytes: 990,
    quotaBytes: 1_000,
    persisted: true,
    bytesPerMs: 0.000_000_1,
  });
  assert.equal(budget.level, "critical");
});

test("a rate needs enough evidence before it is believed", () => {
  assert.equal(captureRecordingRate(100, 10), undefined, "a 10ms sample is not a rate");
  assert.equal(captureRecordingRate(0, 60_000), undefined);
  assert.equal(captureRecordingRate(Number.NaN, 60_000), undefined);
  assert.equal(captureRecordingRate(60_000, 60_000), 1);
});

test("sizes read as sizes", () => {
  assert.equal(formatCaptureBytes(0), "0 MB");
  assert.equal(formatCaptureBytes(2_048), "2 KB");
  assert.equal(formatCaptureBytes(50 * 1024 ** 2), "50 MB");
  assert.equal(formatCaptureBytes(3 * 1024 ** 3), "3.0 GB");
});

test("persistence is not asked for twice when it is already granted", async () => {
  let persistCalls = 0;
  const granted = await ensureCapturePersistence({
    persisted: async () => true,
    persist: async () => {
      persistCalls += 1;
      return true;
    },
  });
  assert.equal(granted, true);
  assert.equal(persistCalls, 0);
});

test("a declined or missing persistence API is an answer, not a failure", async () => {
  assert.equal(await ensureCapturePersistence(undefined), false);
  assert.equal(await ensureCapturePersistence({}), false);
  assert.equal(await ensureCapturePersistence({ persisted: async () => false, persist: async () => false }), false);
  assert.equal(
    await ensureCapturePersistence({
      persisted: async () => {
        throw new Error("denied");
      },
    }),
    false,
    "a thrown request must not stop the user recording",
  );
});

test("persistence is requested when it has not been granted yet", async () => {
  const granted = await ensureCapturePersistence({ persisted: async () => false, persist: async () => true });
  assert.equal(granted, true);
});

test("a check-only call reads the grant without asking for it", async () => {
  // The page opens the store on load just to see whether a crashed meeting is
  // waiting; that must not raise a permission prompt.
  let persistCalls = 0;
  const api = {
    persisted: async () => false,
    persist: async () => {
      persistCalls += 1;
      return true;
    },
  };
  assert.equal(await ensureCapturePersistence(api, { request: false }), false);
  assert.equal(persistCalls, 0);
  assert.equal(await ensureCapturePersistence(api), true);
  assert.equal(persistCalls, 1);
});
