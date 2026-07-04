import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createRuntimeRunnerClient,
  RuntimeManager,
  startRuntimeServer,
} from '../runtime/index.js';
import { withTempWorkspaceAsync } from './_helpers.js';

test('runtime runner client drives the in-process runner by default', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const seen: string[] = [];
    const client = createRuntimeRunnerClient({
      workspaceRoot: ws,
      executeTurn: async (turn, spec) => {
        seen.push(`${spec.sessionKey}:${turn.prompt}`);
        return `local:${turn.prompt}`;
      },
    });

    assert.equal(client.mode, 'in-process');
    const started = await client.start({ sessionKey: 'session:local', kind: 'process' });
    assert.equal(started.status, 'ready');
    assert.equal(started.kind, 'process');

    const sent = await client.send({ sessionKey: 'session:local', runtimeId: started.runtimeId, prompt: 'hello' });
    assert.deepEqual(sent, { runtimeId: started.runtimeId, output: 'local:hello' });
    assert.deepEqual(seen, ['session:local:hello']);

    const status = await client.status({ sessionKey: 'session:local', runtimeId: started.runtimeId });
    assert.equal(status.status, 'ready');
    assert.equal(status.live, true);

    await client.writeFile({
      sessionKey: 'session:local',
      runtimeId: started.runtimeId,
      path: 'out/client.txt',
      content: 'client\n',
    });
    assert.equal(fs.readFileSync(`${ws}/out/client.txt`, 'utf8'), 'client\n');
    const file = await client.readFile({ sessionKey: 'session:local', runtimeId: started.runtimeId, path: 'out/client.txt' });
    assert.equal(file.content, 'client\n');

    await assert.rejects(
      () => client.readFile({ sessionKey: 'session:local', runtimeId: started.runtimeId, path: '../outside.txt' }),
      /path_outside_workspace/,
    );
  });
});

test('runtime runner client uses a remote runner when a URL is configured', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const seen: string[] = [];
    const manager = new RuntimeManager({
      workspaceRoot: ws,
      executeTurn: async (turn, spec) => {
        seen.push(`${spec.sessionKey}:${turn.prompt}`);
        return `remote:${turn.prompt}`;
      },
    });
    const handle = await startRuntimeServer({ enabled: true, manager, workspaceRoot: ws, port: 0 });
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push(new URL(input.toString()).pathname);
      return fetch(input, init);
    };
    const client = createRuntimeRunnerClient({
      workspaceRoot: ws,
      executeTurn: async () => 'unused',
      remoteUrl: `http://${handle.host}:${handle.port}`,
      fetch: fetchImpl,
    });

    try {
      assert.equal(client.mode, 'remote');
      const started = await client.start({ sessionKey: 'session:remote', kind: 'process' });
      assert.equal(started.status, 'ready');

      const sent = await client.send({ sessionKey: 'session:remote', runtimeId: started.runtimeId, prompt: 'ping' });
      assert.equal(sent.output, 'remote:ping');
      assert.deepEqual(seen, ['session:remote:ping']);

      const status = await client.status({ sessionKey: 'session:remote', runtimeId: started.runtimeId });
      assert.equal(status.status, 'ready');
      assert.equal(status.live, true);

      assert.equal(calls[0], '/runtime/v1/server_info');
      assert.equal(calls.filter((path) => path === '/runtime/v1/server_info').length, 1);
    } finally {
      await handle.close();
    }
  });
});
