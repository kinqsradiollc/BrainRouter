import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-sync-home-')));
process.env.HOME = HOME;
process.env.BRAINROUTER_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-sync-br-')));

const { tryHandleUiCommand } = await import('../cli/commands/ui.js');
const { getSessionRuntime, setSessionRuntime } = await import('@kinqs/brainrouter-core/dist/session/sessionRuntimeStore.js');

function withMutedConsole(fn: () => Promise<void>): Promise<void> {
  const original = console.log;
  console.log = () => {};
  return fn().finally(() => { console.log = original; });
}

function commandContext(workspaceRoot: string, configModel = 'global-old'): any {
  let model = 'live-old';
  return {
    command: '/model',
    args: [],
    agent: {
      workspaceRoot,
      sessionKey: 'sess:model',
      getModel: () => model,
      setModel: (next: string) => { model = next; },
    },
    mcpClient: {},
    config: {
      activeServer: 'local',
      servers: {},
      llm: { provider: 'openai', apiKey: 'sk-test', model: configModel },
    },
    rl: {},
    repl: {},
    get liveModel() { return model; },
  };
}

test('/model --session persists a sessionRuntime model without touching config.json', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-sync-ws-')));
  const ctx = commandContext(ws);
  ctx.args = ['--session', 'session-new'];

  await withMutedConsole(async () => {
    assert.equal(await tryHandleUiCommand(ctx), true);
  });

  assert.equal(ctx.liveModel, 'session-new');
  assert.equal(ctx.config.llm.model, 'global-old');
  assert.equal(getSessionRuntime(ws, 'sess:model').model, 'session-new');
});

test('/model <name> persists globally and clears a stale sessionRuntime model', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-sync-ws-')));
  setSessionRuntime(ws, 'sess:model', { model: 'session-old' });
  const ctx = commandContext(ws);
  ctx.args = ['global-new'];

  await withMutedConsole(async () => {
    assert.equal(await tryHandleUiCommand(ctx), true);
  });

  assert.equal(ctx.liveModel, 'global-new');
  assert.equal(ctx.config.llm.model, 'global-new');
  assert.equal(getSessionRuntime(ws, 'sess:model').model, undefined);
});
