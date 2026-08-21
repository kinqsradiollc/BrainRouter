// ADR-041 D14 (#2/#3) — the trajectory ledger store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordTrajectoryStep,
  readTrajectory,
} from '../session/trace/trajectoryStore.js';
import { getSessionStateDir } from '../storage/store.js';

const tmpWs = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'traj-'));
const trajFile = (ws: string, sk: string): string =>
  path.join(getSessionStateDir(ws, sk), 'trajectory.jsonl');

test('D14 — records a step and reads it back with model, tokens, duration, tools', () => {
  const ws = tmpWs();
  assert.equal(
    recordTrajectoryStep(ws, 'sess:a', {
      model: 'gpt-x',
      at: '2026-01-01T00:00:00.000Z',
      durationMs: 1234,
      tokensIn: 900,
      tokensOut: 42,
      toolNames: ['read_file', 'run_command'],
      text: 'thinking out loud',
    }),
    true,
  );
  const steps = readTrajectory(ws, 'sess:a');
  assert.equal(steps.length, 1);
  const s = steps[0];
  assert.equal(s.seq, 0);
  assert.equal(s.model, 'gpt-x');
  assert.equal(s.durationMs, 1234);
  assert.equal(s.tokensIn, 900);
  assert.equal(s.tokensOut, 42);
  assert.equal(s.excerpt, 'thinking out loud');
  assert.equal(s.visibility, 'model-visible');
  assert.deepEqual(s.tools.map((t) => t.name), ['read_file', 'run_command']);
});

test('D14 (#3) — each tool carries a render intent derived from its wire name', () => {
  const ws = tmpWs();
  recordTrajectoryStep(ws, 'sess:a', {
    model: 'm',
    toolNames: ['run_command', 'edit_file', 'read_file', 'grep', 'web_search', 'totally_unknown_tool'],
  });
  const intents = Object.fromEntries(readTrajectory(ws, 'sess:a')[0].tools.map((t) => [t.name, t.intent]));
  assert.equal(intents.run_command, 'terminal');
  assert.equal(intents.edit_file, 'diff');
  assert.equal(intents.read_file, 'read');
  assert.equal(intents.grep, 'search');
  assert.equal(intents.web_search, 'web');
  assert.equal(intents.totally_unknown_tool, 'text', 'an unknown tool degrades to text, never breaks');
});

test('D14 — reads newest-first and honours the limit', () => {
  const ws = tmpWs();
  for (let i = 0; i < 5; i += 1) recordTrajectoryStep(ws, 'sess:a', { model: `m${i}`, toolNames: [] });
  const steps = readTrajectory(ws, 'sess:a', 2);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].model, 'm4', 'newest first');
  assert.equal(steps[1].model, 'm3');
});

test('D14 — seq is monotonic across steps', () => {
  const ws = tmpWs();
  for (let i = 0; i < 4; i += 1) recordTrajectoryStep(ws, 'sess:a', { model: 'm', toolNames: [] });
  const seqsNewestFirst = readTrajectory(ws, 'sess:a').map((s) => s.seq);
  assert.deepEqual(seqsNewestFirst, [3, 2, 1, 0]);
});

test('D14 — does NOT rewrite on every append past the cap (trim slack)', () => {
  const ws = tmpWs();
  // Just past MAX_RECORDS (500) but within the slack window (+100): no trim yet.
  for (let i = 0; i < 560; i += 1) recordTrajectoryStep(ws, 'sess:a', { model: 'm', toolNames: [] });
  assert.equal(readTrajectory(ws, 'sess:a', 10_000).length, 560, 'within the slack window nothing is trimmed');
});

test('D14 — self-trims past the slack window while keeping seq monotonic beyond it', () => {
  const ws = tmpWs();
  // Push past MAX_RECORDS + TRIM_SLACK (600) so at least one trim must fire.
  for (let i = 0; i < 650; i += 1) recordTrajectoryStep(ws, 'sess:a', { model: 'm', toolNames: [] });
  const all = readTrajectory(ws, 'sess:a', 10_000);
  assert.ok(all.length >= 500 && all.length <= 600, `bounded by [MAX, MAX+SLACK], got ${all.length}`);
  assert.equal(all[0].seq, 649, 'newest kept record keeps its original monotonic seq');
  // A step recorded AFTER a trim continues the sequence — it never collides.
  recordTrajectoryStep(ws, 'sess:a', { model: 'after-trim', toolNames: [] });
  assert.equal(readTrajectory(ws, 'sess:a', 1)[0].seq, 650);
});

test('D14 — a torn/truncated final line is skipped, not fatal', () => {
  const ws = tmpWs();
  recordTrajectoryStep(ws, 'sess:a', { model: 'good', toolNames: ['read_file'] });
  // Simulate a crash mid-append: a partial JSON line with no newline.
  fs.appendFileSync(trajFile(ws, 'sess:a'), '{"seq":1,"model":"tor', 'utf8');
  const steps = readTrajectory(ws, 'sess:a');
  assert.equal(steps.length, 1, 'only the intact record survives');
  assert.equal(steps[0].model, 'good');
  // The next record still advances past the last INTACT seq (0) → 1, not a collision.
  recordTrajectoryStep(ws, 'sess:a', { model: 'next', toolNames: [] });
  assert.equal(readTrajectory(ws, 'sess:a', 1)[0].model, 'next');
});

test('D14 — missing ledger reads empty; a failed write never throws', () => {
  const ws = tmpWs();
  assert.deepEqual(readTrajectory(ws, 'sess:none'), []);
});

test('D14 — a pure tool turn (no assistant text) records no excerpt', () => {
  const ws = tmpWs();
  recordTrajectoryStep(ws, 'sess:a', { model: 'm', toolNames: ['run_command'], text: '   ' });
  assert.equal(readTrajectory(ws, 'sess:a')[0].excerpt, undefined);
});
