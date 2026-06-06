import test from "node:test";
import assert from "node:assert/strict";
import { listDatasetFixtures, resolveDatasetFixture } from "./dataset-resolver.js";

test("resolveDatasetFixture resolves the tiny smoke fixture", () => {
  const result = resolveDatasetFixture("tiny");
  assert.equal(result.ok, true);
  assert.match(result.filePath ?? "", /tiny-memory\.json$/);
});

test("listDatasetFixtures exposes MemBench splits", () => {
  const ids = listDatasetFixtures().map((fixture) => fixture.id);
  assert.ok(ids.includes("membench:ps-fm:10k"));
  assert.ok(ids.includes("membench:os-rm:100k"));
});

test("resolveDatasetFixture requires MemBench splits to be imported", () => {
  const result = resolveDatasetFixture("membench:ps-fm:10k");
  assert.match(result.filePath ?? "", /datasets\/membench\/ps-fm-10k\.json$/);
  if (!result.ok) {
    assert.match(result.errors.join("\n"), /has not been imported/);
  }
});
