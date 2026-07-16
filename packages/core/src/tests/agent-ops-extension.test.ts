/**
 * agent-ops extension — verifies the built-in extension registers its three
 * tools and that each drives the REAL core system it integrates with:
 *   - schedule_task  → the schedule store (schedules.json)
 *   - notify_user    → the completion inbox singleton
 *   - session_info   → the session meta / transcript / orchestration stores
 *
 * The extension is plain ESM under `extensions/agent-ops/index.js` and is loaded
 * via a non-literal dynamic import so tsc doesn't try to type the JS module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadSchedules } from '../schedule/index.js';
import { peekCompletions, __resetCompletionInbox } from '../session/completion/completionInbox.js';
import { appendTranscriptEntry } from '../session/transcript/sessionStore.js';
import { setSessionMeta } from '../session/state/sessionMetaStore.js';
import type { ExtensionToolDef, ExtensionHost } from '../extension/host.js';

const SESSION_KEY_ENV = 'BRAINROUTER_RUNTIME_SESSION_KEY';

interface Harness {
  tools: Map<string, ExtensionToolDef>;
  host: ExtensionHost;
}

function makeHost(workspaceRoot: string): Harness {
  const tools = new Map<string, ExtensionToolDef>();
  const host: ExtensionHost = {
    workspaceRoot,
    version: 'test',
    log: () => {},
    registerTool: (def) => tools.set(def.name, def),
    registerProvider: () => {},
    registerHook: () => {},
    registerPanel: () => {},
  };
  return { tools, host };
}

async function loadExtension(): Promise<{ activate: (host: ExtensionHost) => Promise<void> }> {
  // Non-literal specifier → tsc treats the import as `any` (no type resolution
  // of the plain-JS extension module). Resolves dist/tests → extensions/.
  const url = new URL('../../extensions/agent-ops/index.js', import.meta.url).href;
  return import(/* @vite-ignore */ url as string);
}

function withState<T>(fn: (workspaceRoot: string, sessionKey: string) => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-ws-'));
  const prevHome = process.env.BRAINROUTER_HOME;
  const prevKey = process.env[SESSION_KEY_ENV];
  process.env.BRAINROUTER_HOME = home;
  const sessionKey = 'test-session-1';
  process.env[SESSION_KEY_ENV] = sessionKey;
  __resetCompletionInbox();
  return fn(ws, sessionKey).finally(() => {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = prevHome;
    if (prevKey === undefined) delete process.env[SESSION_KEY_ENV];
    else process.env[SESSION_KEY_ENV] = prevKey;
    __resetCompletionInbox();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });
}

test('agent-ops registers the three tools at the expected tiers', async () => {
  await withState(async (ws) => {
    const { tools, host } = makeHost(ws);
    const ext = await loadExtension();
    await ext.activate(host);
    assert.ok(tools.has('schedule_task'));
    assert.ok(tools.has('notify_user'));
    assert.ok(tools.has('session_info'));
    assert.equal(tools.get('session_info')!.accessTier, 'read');
    assert.equal(tools.get('schedule_task')!.accessTier, 'write');
    assert.equal(tools.get('notify_user')!.accessTier, 'write');
    for (const name of ['schedule_task', 'notify_user', 'session_info']) {
      const s = tools.get(name)!.inputSchema as { type?: string };
      assert.equal(s.type, 'object', `${name} schema is an object`);
    }
  });
});

test('schedule_task create/list/cancel hits the real schedule store', async () => {
  await withState(async (ws, sessionKey) => {
    const { tools, host } = makeHost(ws);
    await (await loadExtension()).activate(host);
    const tool = tools.get('schedule_task')!;

    const created = JSON.parse(await tool.handle({ action: 'create', command: '/ci-status', cron: '*/15 * * * *' }));
    assert.equal(created.ok, true);
    assert.equal(created.kind, 'cron');
    assert.equal(created.owner, sessionKey);

    // The record is really persisted, owned by this session, with a future nextRun.
    const persisted = loadSchedules(ws);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].command, '/ci-status');
    assert.equal(persisted[0].owner, sessionKey);
    assert.ok(Date.parse(persisted[0].nextRun) > Date.now());

    const listed = JSON.parse(await tool.handle({ action: 'list' }));
    assert.equal(listed.count, 1);
    assert.equal(listed.tasks[0].id, created.id);

    const cancelled = JSON.parse(await tool.handle({ action: 'cancel', id: created.id }));
    assert.equal(cancelled.ok, true);
    assert.equal(loadSchedules(ws).length, 0);
  });
});

test('schedule_task cancel is owner-scoped — a session cannot cancel another session\'s task (CWE-639)', async () => {
  await withState(async (ws, sessionKey) => {
    const { tools, host } = makeHost(ws);
    await (await loadExtension()).activate(host);
    const tool = tools.get('schedule_task')!;

    // Session A (the withState default) creates a task.
    const created = JSON.parse(await tool.handle({ action: 'create', command: '/ci-status', in: '5m' }));
    assert.equal(created.owner, sessionKey);
    // Assertions below are on the tool's RETURN VALUES for `created.id` specifically —
    // not absolute store counts — so this stays correct even though the sibling tests
    // run concurrently against a HOME-scoped state store.

    // A DIFFERENT session is refused when it tries to cancel A's task, and existence
    // is not disclosed (same error as a genuinely-missing id).
    process.env[SESSION_KEY_ENV] = 'test-session-2';
    try {
      const denied = JSON.parse(await tool.handle({ action: 'cancel', id: created.id }));
      assert.equal(denied.ok, false, 'session B is refused');
      assert.equal(denied.removed, false, 'B\'s cancel removes nothing');
      assert.equal(denied.error, `no task with id ${created.id}`, 'existence is not disclosed');
    } finally {
      process.env[SESSION_KEY_ENV] = sessionKey;
    }

    // The owning session CAN still cancel its own task — which also proves B's attempt
    // did not remove it (removed:true means created.id was still present).
    const ok = JSON.parse(await tool.handle({ action: 'cancel', id: created.id }));
    assert.equal(ok.ok, true);
    assert.equal(ok.removed, true, 'A\'s task survived B\'s attempt and A can cancel it');
  });
});

test('schedule_task one-shot "in" and validation', async () => {
  await withState(async (ws) => {
    const { tools, host } = makeHost(ws);
    await (await loadExtension()).activate(host);
    const tool = tools.get('schedule_task')!;

    const ok = JSON.parse(await tool.handle({ action: 'create', command: '/agents', in: '5m' }));
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, 'once');

    // Non-slash command rejected.
    const bad = JSON.parse(await tool.handle({ action: 'create', command: 'agents', in: '5m' }));
    assert.equal(bad.ok, false);
    // Zero-or-multiple time modes rejected.
    const two = JSON.parse(await tool.handle({ action: 'create', command: '/agents', in: '5m', cron: '* * * * *' }));
    assert.equal(two.ok, false);
  });
});

test('notify_user enqueues into the real completion inbox', async () => {
  await withState(async (ws, sessionKey) => {
    const { tools, host } = makeHost(ws);
    await (await loadExtension()).activate(host);
    const tool = tools.get('notify_user')!;

    const res = JSON.parse(await tool.handle({ message: 'build finished', title: 'CI', level: 'success' }));
    assert.equal(res.ok, true);
    assert.equal(res.session, sessionKey);

    const pending = peekCompletions(sessionKey);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].summary, 'build finished');
    assert.equal(pending[0].status, 'completed');

    const err = JSON.parse(await tool.handle({ message: 'boom', level: 'error' }));
    assert.equal(peekCompletions(sessionKey).length, 2);
    assert.equal(JSON.parse(JSON.stringify(err)).ok, true);
    assert.equal(peekCompletions(sessionKey)[1].status, 'failed');
  });
});

test('session_info reads the real session meta + transcript stores', async () => {
  await withState(async (ws, sessionKey) => {
    setSessionMeta(ws, sessionKey, { title: 'My Session' });
    appendTranscriptEntry(ws, sessionKey, { role: 'user', content: 'hello world' });
    appendTranscriptEntry(ws, sessionKey, { role: 'assistant', content: 'hi there' });

    const { tools, host } = makeHost(ws);
    await (await loadExtension()).activate(host);
    const tool = tools.get('session_info')!;

    const info = JSON.parse(await tool.handle({ limit: 5 }));
    assert.equal(info.currentSessionKey, sessionKey);
    assert.equal(info.title, 'My Session');
    assert.ok(Array.isArray(info.recentActivity));
    assert.ok(info.recentActivity.length >= 2);
    assert.equal(info.recentActivity.at(-1).preview, 'hi there');
    assert.ok(Array.isArray(info.recentSessions));
    assert.ok(Array.isArray(info.childAgents));
  });
});
