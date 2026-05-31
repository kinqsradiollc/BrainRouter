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

test("ResultCache: put/get, TTL expiry (no access), max-entry eviction (injected clock)", () => {
  let now = 1000;
  const cache = new ResultCache(100, 2, () => now);
  cache.put("a", "AAA");
  assert.equal(cache.get("a"), "AAA");
  now = 1101; // no intervening access slid the window → expired
  assert.equal(cache.get("a"), undefined);

  now = 2000;
  cache.put("x", "1");
  cache.put("y", "2");
  cache.put("z", "3"); // exceeds maxEntries=2 → least-recently-used (x) evicted
  assert.equal(cache.get("x"), undefined);
  assert.equal(cache.get("y"), "2");
  assert.equal(cache.get("z"), "3");
});

test("MEM-22 sliding TTL: an access extends the ref's lifetime (active protection)", () => {
  let now = 1000;
  const cache = new ResultCache(100, 8, () => now);
  cache.put("a", "AAA");
  now = 1090;
  assert.equal(cache.get("a"), "AAA"); // slides expiry to 1190 (would die at 1100 without sliding)
  now = 1180;
  assert.equal(cache.get("a"), "AAA"); // still alive; slides to 1280
  now = 1281;
  assert.equal(cache.get("a"), undefined); // finally idle-expired
});

test("MEM-22 LRU eviction protects the recently-used ref over the idle one", () => {
  let now = 0;
  const cache = new ResultCache(10_000, 2, () => now);
  cache.put("a", "1");
  now = 1; cache.put("b", "2");
  now = 2; assert.equal(cache.get("a"), "1"); // touch a → most-recently-used
  now = 3; cache.put("c", "3"); // overflow → evict LRU = b, NOT the touched a
  assert.equal(cache.get("a"), "1");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("c"), "3");
});

test("MEM-22 reclaim: removes expired orphans, reports stats, keeps active", () => {
  let now = 0;
  const cache = new ResultCache(100, 10, () => now);
  cache.put("keep", "active-ref");
  cache.put("idle", "idle-orphan");
  now = 50; cache.get("keep"); // slide keep to 150
  now = 120; // idle (exp 100) is expired; keep (exp 150) alive
  const stats = cache.reclaim();
  assert.equal(stats.expired, 1);
  assert.equal(stats.bytesReclaimed, "idle-orphan".length);
  assert.equal(stats.remaining, 1);
  assert.equal(cache.get("keep"), "active-ref");
});

test("MEM-22 reclaim: a protected ref is kept + refreshed even when expired", () => {
  let now = 0;
  const cache = new ResultCache(100, 10, () => now);
  cache.put("a", "AAA");
  cache.put("b", "BBB");
  now = 200; // both past TTL (exp 100)
  const stats = cache.reclaim(new Set(["a"]));
  assert.equal(stats.expired, 1); // only b
  assert.equal(stats.protectedKept, 1); // a kept
  assert.equal(cache.get("a"), "AAA"); // refreshed → still resolvable
  assert.equal(cache.get("b"), undefined);
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
