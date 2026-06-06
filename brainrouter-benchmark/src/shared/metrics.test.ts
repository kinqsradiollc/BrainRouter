import test from "node:test";
import assert from "node:assert/strict";
import { meanReciprocalRank, ndcgAtK, percentile, precisionAtK, recallAtK } from "./metrics.js";

test("retrieval metrics score ranked hits", () => {
  const relevant = new Set(["b", "d"]);
  const retrieved = ["a", "b", "c", "d"];
  assert.equal(recallAtK(retrieved, relevant, 2), 0.5);
  assert.equal(precisionAtK(retrieved, relevant, 2), 0.5);
  assert.equal(meanReciprocalRank(retrieved, relevant), 0.5);
  assert.ok(ndcgAtK(retrieved, relevant, 4) > 0.6);
});

test("percentile uses nearest-rank semantics", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 90), 40);
  assert.equal(percentile([], 99), 0);
});
