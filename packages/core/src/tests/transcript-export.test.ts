import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportTranscriptMarkdown,
  exportTranscriptJson,
  exportFileName,
} from '../session/transcript/transcriptExport.js';
import type { TranscriptEntry } from '../session/transcript/sessionStore.js';

const META = { sessionKey: 'sess:abc-123', exportedAt: '2026-06-10T02:30:00.000Z' };

const SAMPLE: TranscriptEntry[] = [
  { role: 'user', content: 'find the bug', timestamp: '2026-06-10T02:29:00.000Z' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep_search', arguments: '{"q":"bug"}' } }],
    timestamp: '2026-06-10T02:29:05.000Z',
  },
  { role: 'tool', name: 'grep_search', content: 'router.ts:42', isError: false, timestamp: '2026-06-10T02:29:06.000Z' },
  { role: 'assistant', content: 'The bug is in router.ts:42 — fixed.', timestamp: '2026-06-10T02:29:10.000Z' },
];

test('exportTranscriptMarkdown: header, roles, tool calls + results render', () => {
  const md = exportTranscriptMarkdown(SAMPLE, META);
  assert.match(md, /# BrainRouter session transcript/);
  assert.match(md, /Session: `sess:abc-123`/);
  assert.match(md, /Entries: 4/);
  assert.match(md, /## ❯ User/);
  assert.match(md, /find the bug/);
  assert.match(md, /Tool calls: `grep_search\(\{"q":"bug"\}\)`/);
  assert.match(md, /### ⎿ Tool result `grep_search`/);
  assert.match(md, /router\.ts:42/);
  assert.match(md, /The bug is in router\.ts:42 — fixed\./);
});

test('exportTranscriptMarkdown: a failed tool result is flagged', () => {
  const md = exportTranscriptMarkdown(
    [{ role: 'tool', name: 'run_command', content: 'boom', isError: true, timestamp: META.exportedAt }],
    META,
  );
  assert.match(md, /### ⎿ Tool result `run_command` ✗/);
});

test('exportTranscriptJson: round-trips entries + meta', () => {
  const obj = JSON.parse(exportTranscriptJson(SAMPLE, META));
  assert.equal(obj.sessionKey, 'sess:abc-123');
  assert.equal(obj.exportedAt, META.exportedAt);
  assert.equal(obj.entries.length, 4);
  assert.equal(obj.entries[0].content, 'find the bug');
});

test('exportFileName: filesystem-safe key + stamp + extension', () => {
  const name = exportFileName('sess:abc/123', 'md', '2026-06-10T02:30:00.000Z');
  assert.match(name, /^brainrouter-transcript-sess_abc_123-2026-06-10T02-30-00\.md$/);
  assert.match(exportFileName('x', 'json', META.exportedAt), /\.json$/);
});
