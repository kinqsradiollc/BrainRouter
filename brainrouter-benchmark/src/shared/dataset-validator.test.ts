import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAndValidateDataset, validateBenchmarkDataset } from "./dataset-validator.js";

test("validateBenchmarkDataset accepts a valid tiny shape", () => {
  const result = validateBenchmarkDataset({
    id: "x",
    version: "1",
    source: "test",
    records: [{ id: "r1", content: "hello" }],
    queries: [{ id: "q1", query: "hello?", goldRecordIds: ["r1"] }],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.dataset?.id, "x");
});

test("validateBenchmarkDataset rejects missing gold labels", () => {
  const result = validateBenchmarkDataset({
    id: "x",
    version: "1",
    source: "test",
    records: [{ id: "r1", content: "hello" }],
    queries: [{ id: "q1", query: "hello?", goldRecordIds: ["missing"] }],
  });
  assert.match(result.errors.join("\n"), /missing gold record/);
});

test("loadAndValidateDataset rejects zero-byte files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-bench-"));
  const file = path.join(dir, "empty.json");
  fs.writeFileSync(file, "");
  const result = loadAndValidateDataset(file);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /zero bytes/);
});

test("loadAndValidateDataset rejects malformed JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-bench-"));
  const file = path.join(dir, "malformed.json");
  fs.writeFileSync(file, "{ nope");
  const result = loadAndValidateDataset(file);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /malformed/);
});
