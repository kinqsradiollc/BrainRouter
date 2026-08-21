// ADR-041 D14 — the request-header trace store (commitment #1 substrate).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordRequestTrace,
  readRequestTrace,
  clampExcerpt,
  type RequestTraceRecord,
} from '../session/trace/requestTraceStore.js';
import { getSessionStateDir } from '../storage/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reqtrace-'));

function rec(over: Partial<RequestTraceRecord> = {}): RequestTraceRecord {
  return {
    at: new Date().toISOString(),
    model: 'gpt-x',
    messageCount: 3,
    systemChars: 42,
    systemExcerpt: 'You are BrainRouter.',
    toolNames: ['read_file', 'run_command'],
    ...over,
  };
}

test('D14 — request trace round-trips (append then read newest-last)', () => {
  const dir = tmp();
  const sk = 'sess-1';
  assert.deepEqual(readRequestTrace(dir, sk), [], 'empty before any write');
  assert.equal(recordRequestTrace(dir, sk, rec({ model: 'a' })), true);
  assert.equal(recordRequestTrace(dir, sk, rec({ model: 'b' })), true);
  const out = readRequestTrace(dir, sk);
  assert.deepEqual(out.map((r) => r.model), ['a', 'b'], 'newest last');
  assert.equal(out[1]!.toolNames.length, 2);
});

test('D14 — read honors the limit (returns the most recent N)', () => {
  const dir = tmp();
  const sk = 'sess-2';
  for (let i = 0; i < 10; i++) recordRequestTrace(dir, sk, rec({ model: `m${i}` }));
  const out = readRequestTrace(dir, sk, 3);
  assert.deepEqual(out.map((r) => r.model), ['m7', 'm8', 'm9']);
});

test('D14 — the file self-trims so it cannot grow unbounded', () => {
  const dir = tmp();
  const sk = 'sess-3';
  for (let i = 0; i < 250; i++) recordRequestTrace(dir, sk, rec({ model: `m${i}` }));
  const all = readRequestTrace(dir, sk, 0);
  assert.ok(all.length <= 200, `kept ${all.length}, expected <= 200`);
  assert.equal(all[all.length - 1]!.model, 'm249', 'the most recent record survives the trim');
});

test('D14 — clampExcerpt bounds a huge rendered prompt', () => {
  const big = 'x'.repeat(9000);
  const clamped = clampExcerpt(big);
  assert.ok(clamped.length < big.length);
  assert.match(clamped, /\[\+\d+ chars\]$/);
  assert.equal(clampExcerpt('short'), 'short');
});

test('D14 — a torn last line (crash mid-append) is skipped, not fatal', () => {
  const dir = tmp();
  const sk = 'sess-4';
  recordRequestTrace(dir, sk, rec({ model: 'ok' }));
  // Append a partial write (a crash mid-append) after the clean record, at the
  // exact path the store uses.
  const file = path.join(getSessionStateDir(dir, sk), 'request-trace.jsonl');
  fs.appendFileSync(file, '{"model":"torn", not json\n', 'utf8');
  const out = readRequestTrace(dir, sk);
  assert.deepEqual(out.map((r) => r.model), ['ok'], 'the good record reads; the torn line is skipped');
});
