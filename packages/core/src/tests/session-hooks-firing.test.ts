/**
 * ADR-048 S1 — the session hook pair actually FIRES.
 *
 * `session-start` and `session-end` sat in the HookEvent union (CC-parity,
 * 0.4.17) with a tested directives parser and zero production call sites. These
 * tests prove the seams are real: session-start fires on the FIRST prepared turn
 * of a session only, its additionalContext joins that prompt and its
 * sessionTitle renames the session; session-end fires inside endSession().
 *
 * Same process-global-state discipline as hook-contracts.test.ts: serial() so
 * concurrent siblings can't clobber each other's temp workspace/hooks.json.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../agent/agent.js';
import { addHook } from '../hooks/hooksStore.js';
import { getSessionMeta } from '../session/state/sessionMetaStore.js';
import { withTempWorkspaceAsync } from './_helpers.js';

let _gate: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = _gate.then(fn, fn);
  _gate = run.then(() => undefined, () => undefined);
  return run;
}

const stubMcp: any = {
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [{ text: '{}' }] }),
  close: async () => {},
};

/** One-shot LLM mock returning a plain answer; captures each request body. */
function answerOnly(bodies: any[]): typeof fetch {
  return (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
}

const cb = { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} } as any;

function userContent(body: any): string {
  return (body.messages ?? [])
    .filter((m: any) => m.role === 'user')
    .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

/** Just the CURRENT turn's user message (history carries earlier ones forward). */
function lastUserContent(body: any): string {
  const users = (body.messages ?? []).filter((m: any) => m.role === 'user');
  const last = users[users.length - 1];
  return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
}

test('session-start fires on the FIRST turn only; additionalContext joins that prompt; title applies', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    const marker = path.join(workspace, 'session-start.count');
    addHook(workspace, {
      event: 'session-start',
      command: `echo x >> "${marker}" && echo '{"additionalContext":"repo uses pnpm, never npm","sessionTitle":"wired session"}'`,
    });
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
    const originalFetch = globalThis.fetch;
    const bodies: any[] = [];
    try {
      globalThis.fetch = answerOnly(bodies);
      await agent.runTurn('first turn', cb);
      await agent.runTurn('second turn', cb);
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Fired exactly once for the session, not once per turn.
    assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1);
    // The first prompt carried the injected session context; the second did not.
    assert.match(userContent(bodies[0]), /\[session context\]/);
    assert.match(userContent(bodies[0]), /repo uses pnpm, never npm/);
    // Turn 2's OWN prompt carries no session context. Background calls (e.g. the
    // first-turn title proposal) also hit the mock, so locate turn 2's chat call
    // by its prompt text rather than by capture index.
    const turn2 = bodies.find((b) => lastUserContent(b).startsWith('second turn'));
    assert.ok(turn2, 'turn 2 chat request captured');
    assert.doesNotMatch(lastUserContent(turn2), /\[session context\]/);
    // The sessionTitle directive renamed the session.
    assert.equal(getSessionMeta(workspace, agent.sessionKey).title, 'wired session');
  }));
});

test('a session SWITCH is a new session-start; a silent agent never fires one', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    const marker = path.join(workspace, 'starts.count');
    addHook(workspace, { event: 'session-start', command: `echo x >> "${marker}"` });
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = answerOnly([]);
      await agent.runTurn('turn in session A', cb);
      agent.sessionKey = 'session-b';
      await agent.runTurn('turn in session B', cb);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 2);

    // A silent (subagent) agent's turns fire no session-start at all.
    const silentMarker = path.join(workspace, 'silent.count');
    addHook(workspace, { event: 'session-start', command: `echo x >> "${silentMarker}"` });
    const silent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: true,
    });
    const of2 = globalThis.fetch;
    try {
      globalThis.fetch = answerOnly([]);
      await silent.runTurn('silent turn', cb);
    } finally {
      globalThis.fetch = of2;
    }
    assert.equal(fs.existsSync(silentMarker), false);
  }));
});

test('session-end fires inside endSession()', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    const marker = path.join(workspace, 'session-end.marker');
    addHook(workspace, { event: 'session-end', command: `echo done > "${marker}"` });
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: false,
    });
    await agent.endSession(500);
    assert.equal(fs.existsSync(marker), true);
  }));
});
