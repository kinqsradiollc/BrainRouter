import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentForest, formatAgentForest, formatAgentWhy, statusGlyph } from '../orchestration/agentTree.js';
import type { ChildSessionRecord } from '../orchestration/orchestrator.js';

function rec(p: Partial<ChildSessionRecord> & { id: string; parentSessionKey: string; startedAt: string }): ChildSessionRecord {
  return {
    role: 'worker', access: 'write', prompt: 'do the thing', status: 'running',
    updatedAt: p.startedAt, pid: 1,
    ...p,
  } as ChildSessionRecord;
}

const SESSIONS: ChildSessionRecord[] = [
  rec({ id: 'c2', parentSessionKey: 'chat-root', role: 'worker', status: 'completed', startedAt: '2026-01-01T00:02:00Z' }),
  rec({ id: 'c1', parentSessionKey: 'chat-root', role: 'explorer', access: 'read', status: 'running', startedAt: '2026-01-01T00:01:00Z' }),
  rec({ id: 'c1a', parentSessionKey: 'c1', role: 'reviewer', access: 'read', status: 'completed', startedAt: '2026-01-01T00:01:30Z', tier: 'reasoning' }),
];

test('MAS-P5-T5 buildAgentForest: nests by parentSessionKey; orphans = roots; chronological', () => {
  const forest = buildAgentForest(SESSIONS);
  // roots ordered by startedAt: c1 (00:01) before c2 (00:02)
  assert.deepEqual(forest.map((n) => n.id), ['c1', 'c2']);
  // c1a nests under c1 (its parent is a known child id)
  assert.deepEqual(forest[0].children.map((n) => n.id), ['c1a']);
  assert.equal(forest[1].children.length, 0);
});

test('MAS-P5-T5 formatAgentForest: glyphs + nesting + role/tier/status', () => {
  const lines = formatAgentForest(buildAgentForest(SESSIONS));
  const text = lines.join('\n');
  assert.match(text, /▶ c1  explorer  \(running · read\)/);   // running glyph
  assert.match(text, /└─ ✓ c1a  reviewer\/reasoning  \(completed · read\)/); // nested + tier + done glyph
  assert.match(text, /✓ c2  worker  \(completed · write\)/);
  // c1a line is indented under c1 (tree nesting)
  const c1aLine = lines.find((l) => l.includes('c1a'))!;
  assert.ok(c1aLine.startsWith('   '), 'nested child is indented');
});

test('MAS-P5-T6 formatAgentWhy: role, spawner, task, usage', () => {
  const withUsage = { ...SESSIONS[2], usage: { promptTokens: 1200, completionTokens: 300, calls: 4, turns: 2, wallClockMs: 8200 } };
  const lines = formatAgentWhy(withUsage as ChildSessionRecord, SESSIONS).join('\n');
  assert.match(lines, /c1a  —  reviewer\/reasoning  ·  completed/);
  assert.match(lines, /spawned by : c1 \(explorer\)/);   // resolves parent record
  assert.match(lines, /task       : do the thing/);
  assert.match(lines, /usage      : 1200↑ 300↓  ·  4 calls  ·  8\.2s/);
});

test('MAS-P5-T6 formatAgentWhy: root-parented child shows "chat root"', () => {
  assert.match(formatAgentWhy(SESSIONS[1], SESSIONS).join('\n'), /spawned by : chat root/);
});

test('statusGlyph mapping', () => {
  assert.equal(statusGlyph('completed'), '✓');
  assert.equal(statusGlyph('running'), '▶');
  assert.equal(statusGlyph('failed'), '✗');
  assert.equal(statusGlyph('pending'), '○');
  assert.equal(statusGlyph('stale'), '·');
});
