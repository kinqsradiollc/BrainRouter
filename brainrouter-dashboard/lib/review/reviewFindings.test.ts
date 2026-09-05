import test from "node:test";
import assert from "node:assert/strict";
import { filterFindingsByProducer, countFindingsByProducer, findingProducer } from "./reviewFindings.js";

const FINDINGS = [
  { file: "x.ts", severity: "high", title: "SQLi" },
  { file: "src/page.html", severity: "low", title: "Design: side-stripe-border — …", producer: "design-static", advisory: true, rule: "side-stripe-border" },
  { file: "src/page.html", severity: "info", title: "Design: marquee — …", producer: "design-static", advisory: true, rule: "marquee" },
];

test("ADR-056 D-B8: the Review Console filters cards by producer", () => {
  assert.equal(filterFindingsByProducer(FINDINGS, "all").length, 3);
  assert.deepEqual(filterFindingsByProducer(FINDINGS, "model").map((f) => f.file), ["x.ts"]);
  assert.deepEqual(filterFindingsByProducer(FINDINGS, "design").map((f) => f.rule), ["side-stripe-border", "marquee"]);
  assert.deepEqual(countFindingsByProducer(FINDINGS), { model: 1, design: 2 });
  assert.equal(findingProducer({}), "model");
  assert.equal(findingProducer({ producer: "design-static" }), "design");
});
