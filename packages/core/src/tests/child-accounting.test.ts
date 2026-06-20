import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateChildUsage } from '../orchestration/childAccounting.js';
import { createSession, updateSession, listSessions } from '../orchestration/orchestrator.js';

test('aggregateChildUsage sums tokens/calls/offload and ignores usage-less entries', () => {
  const totals = aggregateChildUsage([
    { usage: { promptTokens: 100, completionTokens: 20, calls: 2, offloadedChars: 500 } },
    { usage: { promptTokens: 50, completionTokens: 10, calls: 1, offloadedChars: 0 } },
    {}, // no usage — skipped
    { usage: { promptTokens: 5 } }, // partial — missing fields default to 0
  ]);
  assert.deepEqual(totals, {
    promptTokens: 155,
    completionTokens: 30,
    calls: 3,
    offloadedChars: 500,
  });
});

test('aggregateChildUsage on an empty list is all-zero', () => {
  assert.deepEqual(aggregateChildUsage([]), {
    promptTokens: 0,
    completionTokens: 0,
    calls: 0,
    offloadedChars: 0,
  });
});

test('ChildSessionRecord round-trips the extended usage fields (offloadedChars, wallClockMs)', () => {
  const prevHome = process.env.BRAINROUTER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-acct-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-acct-ws-'));
  process.env.BRAINROUTER_HOME = home;
  try {
    const rec = createSession(ws, { role: 'worker', prompt: 'do a thing', access: 'write', parentSessionKey: 'parent' });
    updateSession(ws, rec.id, {
      status: 'completed',
      usage: { promptTokens: 120, completionTokens: 30, calls: 2, turns: 1, offloadedChars: 4096, wallClockMs: 8200 },
    });
    const reloaded = listSessions(ws).find((s) => s.id === rec.id)!;
    assert.equal(reloaded.usage?.offloadedChars, 4096);
    assert.equal(reloaded.usage?.wallClockMs, 8200);
    assert.equal(reloaded.usage?.promptTokens, 120);
  } finally {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
