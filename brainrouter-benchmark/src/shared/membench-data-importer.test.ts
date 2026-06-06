import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importMemBenchDataSplit } from "./membench-data-importer.js";
import { validateBenchmarkDataset } from "./dataset-validator.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "membench-import-"));
}

// Participation/session shape: nested sessions, gold by [sid, sessionIdx].
const FIRST_RAW = {
  "Single-hop": {
    roles: [
      {
        tid: 0,
        message_list: [
          [
            { sid: 0, user_message: "Hello", assistant_message: "Hi", time: "t0", place: "Boston" },
            { sid: 1, user_message: "My cat is named Tom", assistant_message: "Cute", time: "t1", place: "Boston" },
          ],
          [{ sid: 2, user_message: "Unrelated chatter", assistant_message: "Ok", time: "t2", place: "Boston" }],
        ],
        QA: {
          qid: 0,
          question: "What is my cat's name?",
          answer: "Tom",
          target_step_id: [[1, 0]],
          choices: { A: "Tom", B: "Bob" },
          ground_truth: "A",
        },
      },
    ],
  },
};

// Observation/message shape: flat list, gold by flat int mid.
const THIRD_RAW = {
  "Single-hop": {
    events: [
      {
        tid: 0,
        message_list: [
          { mid: 0, message: "Subordinate is Maya", rel: "subordinate", attr: "name", value: "Maya" },
          { mid: 10, message: "Maya works at Acme", rel: "subordinate", attr: "company", value: "Acme" },
        ],
        QA: { qid: 0, question: "Where does Maya work?", answer: "Acme", target_step_id: [10] },
      },
    ],
  },
};

const FIRST_NOISE = [
  { nid: 0, noise_message: [
    { sid: 0, user: "n0", assistant: "a0" },
    { sid: 1, user: "n1", assistant: "a1" },
    { sid: 2, user: "n2", assistant: "a2" },
  ] },
  { nid: 1, noise_message: [
    { sid: 0, user: "m0", assistant: "b0" },
    { sid: 1, user: "m1", assistant: "b1" },
    { sid: 2, user: "m2", assistant: "b2" },
  ] },
];

test("participation split: gold resolves by (sid, session) and noise is interleaved", () => {
  const dir = tmpDir();
  const rawFile = path.join(dir, "first.json");
  const noiseFile = path.join(dir, "FirstNoise.json");
  const outputPath = path.join(dir, "out.json");
  fs.writeFileSync(rawFile, JSON.stringify(FIRST_RAW));
  fs.writeFileSync(noiseFile, JSON.stringify(FIRST_NOISE));

  const result = importMemBenchDataSplit({
    rawFile,
    outputPath,
    splitId: "membench:ps-fm:10k",
    scenario: "participation",
    memoryLevel: "factual",
    family: "first",
    noiseUnits: 1,
    noiseFile,
    seed: 1337,
  });

  assert.equal(result.trajectories, 1);
  assert.equal(result.noiseRecords, 3); // one noise unit = 3 messages
  assert.equal(result.records, 6); // 3 real turns + 3 noise
  assert.equal(result.queries, 1);

  const dataset = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const { errors } = validateBenchmarkDataset(dataset);
  assert.deepEqual(errors, []);

  const query = dataset.queries[0];
  assert.equal(query.goldRecordIds.length, 1);
  const gold = dataset.records.find((r: { id: string }) => r.id === query.goldRecordIds[0]);
  assert.ok(gold, "gold record must exist");
  assert.match(gold.content, /My cat is named Tom/);
  assert.equal(dataset.records.filter((r: { role?: string }) => r.role === "noise").length, 3);
});

test("observation split: gold resolves by flat int mid; no noise when noiseUnits=0", () => {
  const dir = tmpDir();
  const rawFile = path.join(dir, "third.json");
  const outputPath = path.join(dir, "out.json");
  fs.writeFileSync(rawFile, JSON.stringify(THIRD_RAW));

  const result = importMemBenchDataSplit({
    rawFile,
    outputPath,
    splitId: "membench:os-fm:10k",
    scenario: "observation",
    memoryLevel: "factual",
    family: "third",
    noiseUnits: 0,
    seed: 1337,
  });

  assert.equal(result.records, 2);
  assert.equal(result.noiseRecords, 0);
  assert.equal(result.queries, 1);

  const dataset = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const { errors } = validateBenchmarkDataset(dataset);
  assert.deepEqual(errors, []);
  const gold = dataset.records.find((r: { id: string }) => r.id === dataset.queries[0].goldRecordIds[0]);
  assert.match(gold.content, /Maya works at Acme/);
});

test("conversion is deterministic for a fixed seed", () => {
  const dir = tmpDir();
  const rawFile = path.join(dir, "first.json");
  const noiseFile = path.join(dir, "FirstNoise.json");
  fs.writeFileSync(rawFile, JSON.stringify(FIRST_RAW));
  fs.writeFileSync(noiseFile, JSON.stringify(FIRST_NOISE));

  const run = (out: string) =>
    importMemBenchDataSplit({
      rawFile,
      outputPath: out,
      splitId: "membench:ps-fm:10k",
      scenario: "participation",
      memoryLevel: "factual",
      family: "first",
      noiseUnits: 1,
      noiseFile,
      seed: 42,
    });

  const a = path.join(dir, "a.json");
  const b = path.join(dir, "b.json");
  run(a);
  run(b);
  assert.equal(fs.readFileSync(a, "utf8"), fs.readFileSync(b, "utf8"));
});
