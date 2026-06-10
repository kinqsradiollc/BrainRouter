import test from "node:test";
import assert from "node:assert/strict";
import { meanReciprocalRank, ndcgAtK, percentile, precisionAtK, recallAtK, recallAnyAtK } from "./metrics.js";

test("retrieval metrics score ranked hits", () => {
  const relevant = new Set(["b", "d"]);
  const retrieved = ["a", "b", "c", "d"];
  assert.equal(recallAtK(retrieved, relevant, 2), 0.5);
  assert.equal(precisionAtK(retrieved, relevant, 2), 0.5);
  assert.equal(meanReciprocalRank(retrieved, relevant), 0.5);
  assert.ok(ndcgAtK(retrieved, relevant, 4) > 0.6);
});

test("recall_any@k is binary: any gold in top-k", () => {
  const relevant = new Set(["b", "d"]);
  assert.equal(recallAnyAtK(["a", "b", "c"], relevant, 3), 1); // b is in top-3
  assert.equal(recallAnyAtK(["a", "c", "e"], relevant, 3), 0); // none in top-3
  assert.equal(recallAnyAtK(["a", "b"], relevant, 1), 0); // b is at rank 2, k=1
  assert.equal(recallAnyAtK(["a", "b"], new Set<string>(), 2), 0); // no gold
});

test("percentile uses nearest-rank semantics", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 90), 40);
  assert.equal(percentile([], 99), 0);
});
