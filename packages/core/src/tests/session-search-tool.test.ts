// ADR-041 A41-14 (W2) — the session_search query tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTranscriptEntry } from '../session/transcript/sessionStore.js';
import { builtinToolHandler } from '../extension/builtin/handlers/index.js';
import type { BuiltinToolContext, BuiltinToolHost } from '../extension/builtin/handlers/registry.js';

const tmpWs = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sesssearch-'));

async function callSessionSearch(workspaceRoot: string, args: Record<string, unknown>): Promise<any> {
  const handler = builtinToolHandler('session_search');
  assert.ok(handler, 'session_search is registered as a builtin handler');
  const ctx = {
    args,
    invokedName: 'session_search',
    host: { workspaceRoot, sessionKey: 'sess:caller' } as unknown as BuiltinToolHost,
  } as unknown as BuiltinToolContext;
  return JSON.parse(await handler!(ctx));
}

test('A41-14 — session_search finds the query across sessions and reports which matched', async () => {
  const ws = tmpWs();
  appendTranscriptEntry(ws, 'sess:a', { role: 'user', content: 'we should use postgres for storage', timestamp: '2026-06-10T00:00:01.000Z' });
  appendTranscriptEntry(ws, 'sess:b', { role: 'assistant', content: 'the redis cache is warm', timestamp: '2026-06-10T00:00:02.000Z' });
  appendTranscriptEntry(ws, 'sess:c', { role: 'user', content: 'postgres migration plan', timestamp: '2026-06-10T00:00:03.000Z' });
  const out = await callSessionSearch(ws, { query: 'postgres' });
  const keys = out.results.map((r: any) => r.sessionKey).sort();
  assert.deepEqual(keys, ['sess:a', 'sess:c'], 'both postgres sessions matched, redis did not');
  assert.equal(out.sessionsMatched, 2);
  assert.ok(out.results[0].matches[0].snippet.toLowerCase().includes('postgres'));
});

test('A41-14 — session_search redacts secrets in snippets', async () => {
  const ws = tmpWs();
  appendTranscriptEntry(ws, 'sess:leak', { role: 'assistant', content: 'deploy token sk-ABCDEF1234567890ABCDEF1234567890 rotated', timestamp: '2026-06-10T00:00:01.000Z' });
  const out = await callSessionSearch(ws, { query: 'deploy token' });
  assert.equal(out.sessionsMatched, 1);
  const snippet = out.results[0].matches[0].snippet;
  assert.ok(!snippet.includes('sk-ABCDEF1234567890ABCDEF1234567890'), 'raw secret is not surfaced in a snippet');
});

test('A41-14 — session_search requires a query and honors the per-session limit', async () => {
  const ws = tmpWs();
  await assert.rejects(() => callSessionSearch(ws, {}), /requires a non-empty `query`/);
  for (let i = 0; i < 5; i++) {
    appendTranscriptEntry(ws, 'sess:hits', { role: 'user', content: `alpha hit ${i}`, timestamp: `2026-06-10T00:00:0${i}.000Z` });
  }
  const out = await callSessionSearch(ws, { query: 'alpha', limit: 2 });
  assert.equal(out.results[0].matches.length, 2, 'per-session snippet limit caps the matches');
});

test('A41-14 — session_search with no matches returns an empty result set, not an error', async () => {
  const ws = tmpWs();
  appendTranscriptEntry(ws, 'sess:x', { role: 'user', content: 'hello world', timestamp: '2026-06-10T00:00:01.000Z' });
  const out = await callSessionSearch(ws, { query: 'nonexistent-term-xyz' });
  assert.equal(out.sessionsMatched, 0);
  assert.deepEqual(out.results, []);
});
