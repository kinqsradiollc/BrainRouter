// ADR-041 D14 (#2/#3/#4) — the trajectory ledger store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordTrajectoryStep,
  recordTrajectoryEvent,
  readTrajectory,
  deriveShadowedTrajectory,
  type TrajectoryStep,
  type TrajectoryEvent,
} from '../session/trace/trajectoryStore.js';
import { getSessionStateDir } from '../storage/store.js';

const tmpWs = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'traj-'));
const trajFile = (ws: string, sk: string): string =>
  path.join(getSessionStateDir(ws, sk), 'trajectory.jsonl');
// Narrowing readers for the step-only assertions.
const steps = (w: string, s: string, n?: number): TrajectoryStep[] =>
  readTrajectory(w, s, n).filter((r): r is TrajectoryStep => r.kind === 'step');
const events = (w: string, s: string, n?: number): TrajectoryEvent[] =>
  readTrajectory(w, s, n).filter((r): r is TrajectoryEvent => r.kind === 'event');

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
  const list = steps(ws, 'sess:a');
  assert.equal(list.length, 1);
  const s = list[0];
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
  const intents = Object.fromEntries(steps(ws, 'sess:a')[0].tools.map((t) => [t.name, t.intent]));
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
  const list = steps(ws, 'sess:a', 2);
  assert.equal(list.length, 2);
  assert.equal(list[0].model, 'm4', 'newest first');
  assert.equal(list[1].model, 'm3');
});

test('D14 — seq is monotonic across steps', () => {
  const ws = tmpWs();
  for (let i = 0; i < 4; i += 1) recordTrajectoryStep(ws, 'sess:a', { model: 'm', toolNames: [] });
  assert.deepEqual(readTrajectory(ws, 'sess:a').map((s) => s.seq), [3, 2, 1, 0]);
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
  const list = steps(ws, 'sess:a');
  assert.equal(list.length, 1, 'only the intact record survives');
  assert.equal(list[0].model, 'good');
  // The next record still advances past the last INTACT seq (0) → 1, not a collision.
  recordTrajectoryStep(ws, 'sess:a', { model: 'next', toolNames: [] });
  assert.equal(steps(ws, 'sess:a', 1)[0].model, 'next');
});

test('D14 — missing ledger reads empty; a failed write never throws', () => {
  const ws = tmpWs();
  assert.deepEqual(readTrajectory(ws, 'sess:none'), []);
});

test('D14 — a pure tool turn (no assistant text) records no excerpt', () => {
  const ws = tmpWs();
  recordTrajectoryStep(ws, 'sess:a', { model: 'm', toolNames: ['run_command'], text: '   ' });
  assert.equal(steps(ws, 'sess:a')[0].excerpt, undefined);
});

// ---- D14 #4: log-only events + shadowed overlay ----

test('D14 #4 — records a log-only approval event, interleaved with steps by seq', () => {
  const ws = tmpWs();
  recordTrajectoryStep(ws, 'sess:a', { model: 'm', toolNames: ['edit_file'] });
  assert.equal(
    recordTrajectoryEvent(ws, 'sess:a', { event: 'approval', label: 'edit_file → ask', detail: 'mutating file' }),
    true,
  );
  const ev = events(ws, 'sess:a');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'event');
  assert.equal(ev[0].event, 'approval');
  assert.equal(ev[0].label, 'edit_file → ask');
  assert.equal(ev[0].detail, 'mutating file');
  assert.equal(ev[0].visibility, 'log-only');
  assert.equal(ev[0].seq, 1, 'shares the monotonic sequence with steps');
});

test('D14 #4 — records a compaction event carrying dropped/kept counts', () => {
  const ws = tmpWs();
  recordTrajectoryEvent(ws, 'sess:a', { event: 'compaction', label: 'compaction', droppedMessages: 40, keptMessages: 12, detail: 'summary…' });
  const e = events(ws, 'sess:a')[0];
  assert.equal(e.event, 'compaction');
  assert.equal(e.droppedMessages, 40);
  assert.equal(e.keptMessages, 12);
});

test('D14 #4 — a legacy step record with no `kind` still reads as a step', () => {
  const ws = tmpWs();
  // Write a pre-#4 record shape (no `kind` field) directly.
  fs.appendFileSync(trajFile(ws, 'sess:a'),
    `${JSON.stringify({ seq: 0, model: 'legacy', at: '2026-01-01T00:00:00.000Z', tools: [], visibility: 'model-visible' })}\n`, 'utf8');
  const list = steps(ws, 'sess:a');
  assert.equal(list.length, 1);
  assert.equal(list[0].model, 'legacy');
  assert.equal(list[0].kind, 'step');
});

test('D14 #4 — deriveShadowedTrajectory marks steps before the latest compaction, leaves later ones', () => {
  const ws = tmpWs();
  recordTrajectoryStep(ws, 'sess:a', { model: 'old-1', toolNames: [] });   // seq 0
  recordTrajectoryStep(ws, 'sess:a', { model: 'old-2', toolNames: [] });   // seq 1
  recordTrajectoryEvent(ws, 'sess:a', { event: 'compaction', label: 'compaction', droppedMessages: 5, keptMessages: 1 }); // seq 2
  recordTrajectoryStep(ws, 'sess:a', { model: 'new-1', toolNames: [] });   // seq 3
  const shadowed = deriveShadowedTrajectory(readTrajectory(ws, 'sess:a'));
  const bySeq = new Map(shadowed.map((r) => [r.seq, r]));
  assert.equal(bySeq.get(0)?.visibility, 'shadowed', 'a step before the compaction is shadowed');
  assert.equal(bySeq.get(1)?.visibility, 'shadowed');
  assert.equal(bySeq.get(3)?.visibility, 'model-visible', 'a step after the compaction is not shadowed');
  assert.equal(bySeq.get(2)?.visibility, 'log-only', 'the compaction event itself stays log-only');
});

test('D14 #4 — deriveShadowedTrajectory is a no-op when there is no compaction', () => {
  const ws = tmpWs();
  recordTrajectoryStep(ws, 'sess:a', { model: 'a', toolNames: [] });
  recordTrajectoryStep(ws, 'sess:a', { model: 'b', toolNames: [] });
  const out = deriveShadowedTrajectory(readTrajectory(ws, 'sess:a'));
  assert.ok(out.every((r) => r.visibility === 'model-visible'));
});
