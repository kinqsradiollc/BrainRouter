// ADR-041 A41-14 (W2) — the session_list query tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTranscriptEntry, forkSession } from '../session/transcript/sessionStore.js';
import { builtinToolHandler } from '../extension/builtin/handlers/index.js';
import type { BuiltinToolContext, BuiltinToolHost } from '../extension/builtin/handlers/registry.js';

const tmpWs = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sesslist-'));

/** Invoke session_list with only the fields it reads (workspaceRoot + sessionKey). */
async function callSessionList(workspaceRoot: string, sessionKey: string, args: Record<string, unknown> = {}): Promise<any> {
  const handler = builtinToolHandler('session_list');
  assert.ok(handler, 'session_list is registered as a builtin handler');
  const ctx = {
    args,
    invokedName: 'session_list',
    host: { workspaceRoot, sessionKey } as unknown as BuiltinToolHost,
  } as unknown as BuiltinToolContext;
  return JSON.parse(await handler!(ctx));
}

test('A41-14 — session_list enumerates the workspace sessions, newest first', async () => {
  const ws = tmpWs();
  appendTranscriptEntry(ws, 'sess:one', { role: 'user', content: 'first convo', timestamp: '2026-06-10T00:00:01.000Z' });
  appendTranscriptEntry(ws, 'sess:two', { role: 'user', content: 'second convo', timestamp: '2026-06-10T00:00:02.000Z' });
  const out = await callSessionList(ws, 'sess:two');
  assert.equal(out.workspaceRoot, ws);
  assert.ok(out.count >= 2);
  const keys = out.sessions.map((s: any) => s.sessionKey);
  assert.ok(keys.includes('sess:one') && keys.includes('sess:two'));
  const two = out.sessions.find((s: any) => s.sessionKey === 'sess:two');
  assert.equal(two.title, 'second convo');
  assert.equal(two.current, true, 'the calling session is marked current');
});

test('A41-14 — session_list surfaces fork lineage (forkedFrom)', async () => {
  const ws = tmpWs();
  appendTranscriptEntry(ws, 'sess:root', { role: 'user', content: 'root', timestamp: '2026-06-10T00:00:01.000Z' });
  const forkKey = forkSession(ws, 'sess:root')!;
  const out = await callSessionList(ws, 'sess:root');
  const fork = out.sessions.find((s: any) => s.sessionKey === forkKey);
  assert.equal(fork.forkedFrom, 'sess:root', 'a forked session reports its parent');
  const root = out.sessions.find((s: any) => s.sessionKey === 'sess:root');
  assert.equal(root.forkedFrom, undefined, 'a root session has no parent');
});

test('A41-14 — session_list honors and clamps the limit', async () => {
  const ws = tmpWs();
  for (let i = 0; i < 5; i++) {
    appendTranscriptEntry(ws, `sess:s${i}`, { role: 'user', content: `c${i}`, timestamp: `2026-06-10T00:00:0${i}.000Z` });
  }
  const out = await callSessionList(ws, 'sess:s0', { limit: 2 });
  assert.equal(out.sessions.length, 2, 'limit caps the result');
});
