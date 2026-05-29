import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldHandoff,
  makeResultHandoff,
  formatHandoffForModel,
  ResultCache,
  RESULT_HANDOFF_THRESHOLD_CHARS,
} from "../runtime/resultHandoff.js";
import { extractFromResult, runExtractResult } from "../runtime/tools/extractResult.js";

test("shouldHandoff: at/above threshold only", () => {
  assert.equal(shouldHandoff("x".repeat(RESULT_HANDOFF_THRESHOLD_CHARS)), true);
  assert.equal(shouldHandoff("x".repeat(RESULT_HANDOFF_THRESHOLD_CHARS - 1)), false);
  assert.equal(shouldHandoff(""), false);
});

test("makeResultHandoff: preview head slice + bytes + injectable ref", () => {
  const text = "A".repeat(10_000);
  const { handoff, full } = makeResultHandoff(text, { previewChars: 100, idGenerator: () => "res_fixed" });
  assert.equal(handoff.resultRef, "res_fixed");
  assert.equal(handoff.preview.length, 100);
  assert.equal(handoff.bytes, 10_000);
  assert.ok(handoff.estimatedTokens > 0);
  assert.equal(full, text);
});

test("formatHandoffForModel: footer carries ref + extract_result + durable ref", () => {
  const { handoff } = makeResultHandoff("hello world ".repeat(1000), { idGenerator: () => "res_z" });
  const s = formatHandoffForModel(handoff, { label: "run_command", workingRef: "wm_1" });
  assert.match(s, /resultRef=res_z/);
  assert.match(s, /extract_result/);
  assert.match(s, /durable ref=wm_1/);
  assert.match(s, /run_command output truncated/);
});

test("ResultCache: put/get, TTL expiry, max-entry eviction (injected clock)", () => {
  let now = 1000;
  const cache = new ResultCache(100, 2, () => now);
  cache.put("a", "AAA");
  assert.equal(cache.get("a"), "AAA");
  now = 1099;
  assert.equal(cache.get("a"), "AAA"); // still within TTL
  now = 1101;
  assert.equal(cache.get("a"), undefined); // expired

  now = 2000;
  cache.put("x", "1");
  cache.put("y", "2");
  cache.put("z", "3"); // exceeds maxEntries=2 → oldest (x) evicted
  assert.equal(cache.get("x"), undefined);
  assert.equal(cache.get("y"), "2");
  assert.equal(cache.get("z"), "3");
});

test("extractFromResult: no query returns head + truncated flag", () => {
  const text = "L".repeat(10_000);
  const r = extractFromResult(text, undefined, { maxChars: 500 });
  assert.equal(r.returned.length, 500);
  assert.equal(r.truncated, true);
});

test("extractFromResult: query returns matching lines with context + line numbers", () => {
  const text = ["alpha", "beta", "gamma TARGET here", "delta", "epsilon"].join("\n");
  const r = extractFromResult(text, "target", { contextLines: 1, maxChars: 1000 });
  assert.equal(r.matchedLines, 1);
  assert.match(r.returned, /3: gamma TARGET here/);
  assert.match(r.returned, /2: beta/); // context before
  assert.match(r.returned, /4: delta/); // context after
  assert.ok(!r.returned.includes("alpha")); // outside context window
});

test("extractFromResult: no match → message", () => {
  const r = extractFromResult("nothing here", "zzz");
  assert.match(r.returned, /No lines matched/);
  assert.equal(r.matchedLines, 0);
});

test("runExtractResult: found vs missing ref", () => {
  const cache = new ResultCache(10_000, 8, () => 0);
  cache.put("res_1", "find the NEEDLE in here");
  const ok = runExtractResult({ resultRef: "res_1", query: "needle" }, cache);
  assert.equal(ok.found, true);
  assert.equal(ok.matchedLines, 1);

  const miss = runExtractResult({ resultRef: "res_missing" }, cache);
  assert.equal(miss.found, false);
  assert.match(miss.returned, /not found or expired/);
});
