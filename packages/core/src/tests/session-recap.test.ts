import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecap } from '../session/transcript/sessionRecap.js';
import type { TranscriptEntry } from '../session/transcript/sessionStore.js';

const T = (role: string, content: unknown, extra: Partial<TranscriptEntry> = {}): TranscriptEntry =>
  ({ role, content, timestamp: '2026-06-10T04:00:00.000Z', ...extra });

const call = (name: string, args: object) =>
  ({ id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('buildRecap: counts, last prompt/answer, tools, files, plan, goal', () => {
  const entries: TranscriptEntry[] = [
    T('user', 'fix the recall bug', { timestamp: '2026-06-10T03:00:00.000Z' }),
    T('assistant', '', { tool_calls: [call('read_file', { path: 'src/recall.ts' }), call('grep_search', { query: 'rerank' })] }),
    T('tool', 'found it', { name: 'grep_search' }),
    T('assistant', '', { tool_calls: [call('edit_file', { path: 'src/recall.ts' })] }),
    T('assistant', 'Fixed the rerank blend in src/recall.ts and verified.'),
    T('user', 'now add a test'),
  ];
  const lines = buildRecap({
    entries,
    plan: { updatedAt: '', items: [
      { step: 'fix blend', status: 'completed' },
      { step: 'add regression test', status: 'in_progress' },
    ] },
    goalText: 'ship the recall fix',
    goalStatus: 'active',
    sessionKey: 'sess:r1',
  });
  const text = lines.join('\n');
  assert.match(text, /Session sess:r1/);
  assert.match(text, /6 entries · 2 prompts/);
  assert.match(text, /Last prompt: now add a test/);
  assert.match(text, /Last answer: Fixed the rerank blend/);
  assert.match(text, /Tools: /);
  assert.match(text, /read_file×1/);
  assert.match(text, /src\/recall\.ts \(modified\)/);
  assert.match(text, /src\/recall\.ts$/m); // the read (unmodified) entry
  assert.match(text, /Plan: 1\/2 done — next: add regression test/);
  assert.match(text, /Goal \(active\): ship the recall fix/);
});

test('buildRecap: minimal session — no tools/plan/goal sections', () => {
  const lines = buildRecap({
    entries: [T('user', 'hi'), T('assistant', 'Hello!')],
    sessionKey: 's',
  });
  const text = lines.join('\n');
  assert.match(text, /2 entries · 1 prompts/);
  assert.ok(!text.includes('Tools:'));
  assert.ok(!text.includes('Plan:'));
  assert.ok(!text.includes('Goal'));
});

test('buildRecap: long content is clipped to one line', () => {
  const lines = buildRecap({
    entries: [T('user', 'x'.repeat(500) + '\nsecond line')],
    sessionKey: 's',
  });
  const prompt = lines.find((l) => l.startsWith('Last prompt:'))!;
  assert.ok(prompt.length < 140);
  assert.ok(prompt.endsWith('…'));
  assert.ok(!prompt.includes('\n'));
});
