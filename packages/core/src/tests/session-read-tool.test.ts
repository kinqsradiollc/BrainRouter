// ADR-041 A41-14 (W2) — the session_read query tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTranscriptEntry } from '../session/transcript/sessionStore.js';
import { builtinToolHandler } from '../extension/builtin/handlers/index.js';
import type { BuiltinToolContext, BuiltinToolHost } from '../extension/builtin/handlers/registry.js';

const tmpWs = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sessread-'));

async function callSessionRead(workspaceRoot: string, args: Record<string, unknown>): Promise<any> {
  const handler = builtinToolHandler('session_read');
  assert.ok(handler, 'session_read is registered as a builtin handler');
  const ctx = {
    args,
    invokedName: 'session_read',
    host: { workspaceRoot, sessionKey: 'sess:caller' } as unknown as BuiltinToolHost,
  } as unknown as BuiltinToolContext;
  return JSON.parse(await handler!(ctx));
}

test('A41-14 — session_read returns another session\'s recent transcript, oldest→newest', async () => {
  const ws = tmpWs();
  appendTranscriptEntry(ws, 'sess:other', { role: 'user', content: 'what is the plan', timestamp: '2026-06-10T00:00:01.000Z' });
  appendTranscriptEntry(ws, 'sess:other', { role: 'assistant', content: 'ship the feature', timestamp: '2026-06-10T00:00:02.000Z' });
  const out = await callSessionRead(ws, { sessionKey: 'sess:other' });
  assert.equal(out.sessionKey, 'sess:other');
  assert.equal(out.count, 2);
  assert.deepEqual(out.entries.map((e: any) => e.content), ['what is the plan', 'ship the feature']);
  assert.equal(out.entries[0].role, 'user');
  assert.equal(out.entries[1].role, 'assistant');
});

test('A41-14 — session_read redacts secrets in a sibling session', async () => {
  const ws = tmpWs();
  appendTranscriptEntry(ws, 'sess:leaky', { role: 'assistant', content: 'the key is sk-ABCDEF1234567890ABCDEF1234567890 done', timestamp: '2026-06-10T00:00:01.000Z' });
  const out = await callSessionRead(ws, { sessionKey: 'sess:leaky' });
  assert.ok(!out.entries[0].content.includes('sk-ABCDEF1234567890ABCDEF1234567890'), 'raw secret is not surfaced');
  assert.match(out.entries[0].content, /REDACTED/);
});

test('A41-14 — session_read requires a sessionKey and clamps the limit', async () => {
  const ws = tmpWs();
  await assert.rejects(() => callSessionRead(ws, {}), /requires a `sessionKey`/);
  for (let i = 0; i < 5; i++) {
    appendTranscriptEntry(ws, 'sess:many', { role: 'user', content: `m${i}`, timestamp: `2026-06-10T00:00:0${i}.000Z` });
  }
  const out = await callSessionRead(ws, { sessionKey: 'sess:many', limit: 2 });
  assert.equal(out.entries.length, 2, 'limit caps the returned entries');
});

test('A41-14 — session_read of an unknown session is empty, not an error', async () => {
  const out = await callSessionRead(tmpWs(), { sessionKey: 'sess:nope' });
  assert.equal(out.count, 0);
  assert.deepEqual(out.entries, []);
});
