import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFanoutRun, getFanoutRun, rankFanoutCandidates, updateFanoutCandidate } from '../fanout/index.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fanout-ws-'));
  fs.mkdirSync(path.join(root, '.git'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-fanout-home-'));
  const old = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  return { root, cleanup: () => { process.env.BRAINROUTER_HOME = old; fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); } };
}

test('creates a durable one-task-to-N-candidates run and updates candidates independently', () => {
  const f = fixture();
  try {
    const run = createFanoutRun(f.root, { task: 'Implement auth', adapterIds: ['codex', 'claude-code', 'brainrouter'] });
    assert.equal(run.candidates.length, 3);
    updateFanoutCandidate(f.root, run.id, run.candidates[1]!.id, { status: 'working', changedFiles: 4 });
    const stored = getFanoutRun(f.root, run.id)!;
    assert.equal(stored.candidates[1]?.changedFiles, 4);
    assert.equal(stored.candidates[0]?.changedFiles, 0);
  } finally { f.cleanup(); }
});

test('candidate ranking rewards completed, tested work and penalizes review findings', () => {
  const ranked = rankFanoutCandidates([
    { id: 'a', adapterId: 'codex', status: 'done', changedFiles: 6, diffSummary: 'src/a.ts tests/a.test.ts', updatedAt: 'x', review: { critical: 0, major: 0, minor: 0 } },
    { id: 'b', adapterId: 'claude-code', status: 'done', changedFiles: 5, diffSummary: 'src/b.ts', updatedAt: 'x', review: { critical: 1, major: 0, minor: 0 } },
  ]);
  assert.equal(ranked[0]?.id, 'a');
  assert.equal(ranked[0]?.rank, 1);
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});
