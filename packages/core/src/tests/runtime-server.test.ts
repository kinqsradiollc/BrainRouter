import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  RuntimeManager,
  RUNTIME_SESSION_HEADER,
  startRuntimeServer,
} from '../runtime/index.js';
import { withTempWorkspaceAsync } from './_helpers.js';

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
}

async function requestJson(base: string, path: string, sessionKey: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      [RUNTIME_SESSION_HEADER]: sessionKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('runtime runner contract: process backend round-trips over loopback HTTP', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    git(ws, 'init', '-q');
    fs.writeFileSync(`${ws}/seed.txt`, 'seed\n');
    git(ws, 'add', 'seed.txt');
    git(ws, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'seed');

    const seen: string[] = [];
    const manager = new RuntimeManager({
      workspaceRoot: ws,
      executeTurn: async (turn, spec) => {
        seen.push(`${spec.sessionKey}:${turn.prompt}`);
        return `answer:${turn.prompt}`;
      },
      maxLive: 0,
    });
    const handle = await startRuntimeServer({ enabled: true, manager, workspaceRoot: ws, port: 0 });
    const base = `http://${handle.host}:${handle.port}/runtime/v1`;
    const sessionKey = 'session:http';
    try {
      const denied = await requestJson(base, '/start', 'wrong', { sessionKey });
      assert.equal(denied.status, 401);

      const started = await requestJson(base, '/start', sessionKey, { sessionKey, kind: 'process', role: 'worker', model: 'test-model' });
      assert.equal(started.status, 200);
      assert.equal(started.body.status, 'ready');
      const runtimeId = started.body.runtimeId as string;
      assert.ok(runtimeId);

      const sent = await requestJson(base, '/send', sessionKey, { runtimeId, prompt: 'hello' });
      assert.equal(sent.status, 200);
      assert.equal(sent.body.output, 'answer:hello');
      assert.deepEqual(seen, ['session:http:hello']);

      const status = await requestJson(base, `/status?runtimeId=${encodeURIComponent(runtimeId)}`, sessionKey);
      assert.equal(status.status, 200);
      assert.equal(status.body.status, 'ready');
      assert.equal(status.body.live, true);

      const events = await requestJson(base, `/events?runtimeId=${encodeURIComponent(runtimeId)}`, sessionKey);
      assert.equal(events.status, 200);
      assert.deepEqual(events.body.events, []);

      const written = await requestJson(base, '/file', sessionKey, { runtimeId, path: 'nested/out.txt', content: 'from runner\n' });
      assert.equal(written.status, 200);
      assert.equal(fs.readFileSync(`${ws}/nested/out.txt`, 'utf8'), 'from runner\n');

      const file = await requestJson(
        base,
        `/file?runtimeId=${encodeURIComponent(runtimeId)}&path=${encodeURIComponent('nested/out.txt')}`,
        sessionKey,
      );
      assert.equal(file.status, 200);
      assert.equal(file.body.content, 'from runner\n');

      const escaped = await requestJson(
        base,
        `/file?runtimeId=${encodeURIComponent(runtimeId)}&path=${encodeURIComponent('../outside')}`,
        sessionKey,
      );
      assert.equal(escaped.status, 403);

      const gitStatus = await requestJson(base, `/git?runtimeId=${encodeURIComponent(runtimeId)}`, sessionKey);
      assert.equal(gitStatus.status, 200);
      assert.equal(gitStatus.body.status.ok, true);
      assert.match(gitStatus.body.status.output, /\?\? nested\//);
    } finally {
      await handle.close();
    }
  });
});

test('runtime runner server remains opt-in', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const manager = new RuntimeManager({ workspaceRoot: ws, executeTurn: async () => 'ok' });
    await assert.rejects(
      () => startRuntimeServer({ enabled: false, manager, workspaceRoot: ws, port: 0 }),
      /disabled/,
    );
  });
});
