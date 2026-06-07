import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLongMemEval, buildLoCoMo } from "./conversation-importer.js";
import { validateBenchmarkDataset } from "./dataset-validator.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("buildLongMemEval: sessions→records, answer_session_ids→gold, dedup across questions", () => {
  const dir = tmp("lme-");
  const input = path.join(dir, "in.json");
  const output = path.join(dir, "out.json");
  fs.writeFileSync(input, JSON.stringify([
    {
      question_id: "q1", question_type: "single-session", question: "Where do I work?", answer: "Acme",
      answer_session_ids: ["s2"],
      haystack_session_ids: ["s1", "s2"],
      haystack_sessions: [
        [{ role: "user", content: "nice weather" }],
        [{ role: "user", content: "I work at Acme" }, { role: "assistant", content: "ok" }],
      ],
    },
    {
      question_id: "q2", question_type: "multi-session", question: "What's my pet?", answer: "cat",
      answer_session_ids: ["s2", "s3"],
      haystack_session_ids: ["s2", "s3"], // s2 shared with q1 → deduped
      haystack_sessions: [
        [{ role: "user", content: "I work at Acme" }],
        [{ role: "user", content: "I have a cat" }],
      ],
    },
  ]));

  const res = buildLongMemEval({ inputPath: input, outputPath: output });
  assert.equal(res.records, 3, "s1,s2,s3 unique sessions");
  assert.equal(res.queries, 2);

  const ds = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.deepEqual(validateBenchmarkDataset(ds).errors, []);
  const q2 = ds.queries.find((q: any) => q.id === "q2");
  assert.deepEqual(q2.goldRecordIds.sort(), ["s2", "s3"]);
  // every gold id resolves to a record
  const recIds = new Set(ds.records.map((r: any) => r.id));
  for (const q of ds.queries) for (const g of q.goldRecordIds) assert.ok(recIds.has(g));
});

test("buildLoCoMo: turns→records by <sample>/<dia_id>, evidence→gold, skip no-evidence", () => {
  const dir = tmp("loco-");
  const input = path.join(dir, "in.json");
  const output = path.join(dir, "out.json");
  fs.writeFileSync(input, JSON.stringify([
    {
      sample_id: "s0",
      conversation: {
        speaker_a: "A", speaker_b: "B",
        session_1_date_time: "2023",
        session_1: [
          { speaker: "A", dia_id: "D1:1", text: "Hi" },
          { speaker: "B", dia_id: "D1:2", text: "I adopted a dog named Rex" },
        ],
      },
      qa: [
        { question: "What's the dog's name?", answer: "Rex", evidence: ["D1:2"], category: 1 },
        { question: "adversarial", answer: "Not mentioned", evidence: [], category: 5 },
      ],
    },
  ]));

  const res = buildLoCoMo({ inputPath: input, outputPath: output });
  assert.equal(res.records, 2);
  assert.equal(res.queries, 1, "no-evidence qa skipped");
  assert.equal(res.skipped, 1);

  const ds = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.deepEqual(validateBenchmarkDataset(ds).errors, []);
  assert.deepEqual(ds.queries[0].goldRecordIds, ["s0/D1:2"]);
  assert.ok(ds.records.some((r: any) => r.id === "s0/D1:2"));
});
