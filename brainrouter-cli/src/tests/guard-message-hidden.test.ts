import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEntry } from '../state/sessionStore.js';
import { exportTranscriptMarkdown } from '../state/transcriptExport.js';
import { buildRecap } from '../state/sessionRecap.js';
import { buildRewindTimeline } from '../runtime/rewindTimeline.js';
import { entryKind } from '../orchestration/agentTranscriptView.js';

/**
 * A `role:'user'` transcript entry WITH a `name` is an injected system/guard
 * message (verification gate, plan-sync, task-tracking, …) — the agent records
 * it so the MODEL gets it as a turn, but it must NEVER render as a message the
 * user typed. These cover every render/extract path that reads user entries.
 */
const e = (role: string, content: string, name?: string): TranscriptEntry =>
  ({ role, content, ...(name ? { name } : {}), timestamp: '2026-06-18T00:00:00.000Z' } as TranscriptEntry);

const realPrompt = e('user', 'add a dark mode toggle');
const guard = e('user', 'Runtime verification guardrail tripped. You wrote files this turn…', 'guard');
const answer = e('assistant', 'Done — added the toggle and ran the tests.');

test('entryKind: a named user entry is system, a bare one is user', () => {
  assert.equal(entryKind(realPrompt), 'user');
  assert.equal(entryKind(guard), 'system');
});

test('exportTranscriptMarkdown: guard entries are NOT exported as "User"', () => {
  const md = exportTranscriptMarkdown([realPrompt, answer, guard], { sessionKey: 's', exportedAt: 'now' });
  // The real prompt appears as a User heading; the guard does not.
  assert.match(md, /## ❯ User/);
  assert.ok(md.includes('add a dark mode toggle'));
  const userHeadings = (md.match(/## ❯ User/g) ?? []).length;
  assert.equal(userHeadings, 1, 'only the real prompt is a User heading, not the guard');
});

test('buildRecap: guard entries do not inflate the prompt count or "last prompt"', () => {
  const recap = buildRecap({ entries: [realPrompt, answer, guard], sessionKey: 's' }).join('\n');
  assert.match(recap, /1 prompts/, 'one real prompt, not two');
  assert.ok(!recap.includes('guardrail'), 'the guard is never shown as the last prompt');
});

test('buildRewindTimeline: guard entries are not rewind points', () => {
  const turns = buildRewindTimeline([realPrompt, answer, guard, answer]);
  assert.equal(turns.length, 1, 'only the real user turn is a rewind point');
  assert.equal(turns[0].userEntryIndex, 0);
});
