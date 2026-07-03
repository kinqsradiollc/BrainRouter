/**
 * MC-D3 — `/profile` slash command (named LLM profiles).
 *
 * Same harness pattern as model-session-sync.test.ts: isolated HOME so
 * config.json reads/writes never touch the developer's real config, a stub
 * agent capturing live LLM changes, and muted console output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-profile-home-')));
process.env.HOME = HOME;
process.env.BRAINROUTER_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-profile-br-')));

const { tryHandleUiCommand } = await import('../cli/commands/ui/index.js');
const { getSessionRuntime, setSessionRuntime } = await import('@kinqs/brainrouter-core/session');

function withMutedConsole(fn: () => Promise<void>): Promise<void> {
  const original = console.log;
  console.log = () => {};
  return fn().finally(() => { console.log = original; });
}

function commandContext(workspaceRoot: string, cli: Record<string, unknown> = {}): any {
  let llm = { provider: 'openai', apiKey: 'sk-test', model: 'live-old', endpoint: 'https://api.example.com/v1' };
  return {
    command: '/profile',
    args: [] as string[],
    agent: {
      workspaceRoot,
      sessionKey: 'sess:profile',
      getModel: () => llm.model,
      setModel: (next: string) => { llm = { ...llm, model: next }; },
      getLlmConfig: () => ({ ...llm }),
      setLLMConfig: (next: any) => { llm = { ...llm, ...next }; },
    },
    mcpClient: {},
    config: {
      activeServer: 'local',
      servers: {},
      llm: { provider: 'openai', apiKey: 'sk-test', model: 'global-old' },
      cli,
    },
    rl: {},
    repl: {},
    get liveLlm() { return llm; },
  };
}

function tmpWs(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-profile-ws-')));
}

test('/profile save snapshots the current model/endpoint into cli.llmProfiles', async () => {
  const ws = tmpWs();
  const ctx = commandContext(ws);
  ctx.args = ['save', 'current'];

  await withMutedConsole(async () => {
    assert.equal(await tryHandleUiCommand(ctx), true);
  });

  const saved = ctx.config.cli.llmProfiles?.current;
  assert.ok(saved, 'profile persisted under cli.llmProfiles');
  assert.equal(saved.model, 'live-old');
  assert.equal(saved.endpoint, 'https://api.example.com/v1');
});

test('/profile use applies the profile live, persists the pointer, labels the session', async () => {
  const ws = tmpWs();
  // A stale per-session model override must be cleared so the profile shows through.
  setSessionRuntime(ws, 'sess:profile', { model: 'stale-session-model' });
  const ctx = commandContext(ws, {
    llmProfiles: {
      fast: { model: 'mini-1' },
      strong: { model: 'big-1', endpoint: 'https://alt.example.com/v1' },
    },
  });
  ctx.args = ['use', 'strong'];

  await withMutedConsole(async () => {
    assert.equal(await tryHandleUiCommand(ctx), true);
  });

  assert.equal(ctx.liveLlm.model, 'big-1', 'live agent switched');
  assert.equal(ctx.liveLlm.endpoint, 'https://alt.example.com/v1', 'profile endpoint applied');
  assert.equal(ctx.config.cli.activeLlmProfile, 'strong', 'global active pointer persisted');
  const rt = getSessionRuntime(ws, 'sess:profile');
  assert.equal(rt.model, undefined, 'stale session model override cleared');
  assert.equal(rt.llmProfile, 'strong', 'session labeled with the active profile');
});

test('/profile use refuses an unknown profile and changes nothing', async () => {
  const ws = tmpWs();
  const ctx = commandContext(ws, { llmProfiles: { fast: { model: 'mini-1' } } });
  ctx.args = ['use', 'ghost'];

  await withMutedConsole(async () => {
    assert.equal(await tryHandleUiCommand(ctx), true);
  });

  assert.equal(ctx.liveLlm.model, 'live-old', 'live model untouched');
  assert.equal(ctx.config.cli.activeLlmProfile, undefined, 'no pointer persisted');
});

test('/profile delete removes the profile and clears a dangling active pointer', async () => {
  const ws = tmpWs();
  const ctx = commandContext(ws, {
    llmProfiles: { fast: { model: 'mini-1' }, strong: { model: 'big-1' } },
    activeLlmProfile: 'strong',
  });
  ctx.args = ['delete', 'strong'];

  await withMutedConsole(async () => {
    assert.equal(await tryHandleUiCommand(ctx), true);
  });

  assert.equal(ctx.config.cli.llmProfiles.strong, undefined, 'profile removed');
  assert.ok(ctx.config.cli.llmProfiles.fast, 'other profiles kept');
  assert.equal(ctx.config.cli.activeLlmProfile, '', 'dangling pointer cleared');
});
