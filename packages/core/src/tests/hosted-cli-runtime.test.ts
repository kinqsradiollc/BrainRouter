import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHostedCliRuntime, RuntimeManager } from '../runtime/index.js';
import { _resetCliKnobsCache, setCliKnobOverride } from '../config/config.js';
import { withTempWorkspaceAsync } from './_helpers.js';

function writeFakeAgent(workspace: string, mode: 'line-json' | 'stdio'): string {
  const file = path.join(workspace, `fake-${mode}.mjs`);
  const body = mode === 'line-json'
    ? `
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      const msg = JSON.parse(line);
      process.stdout.write(JSON.stringify({ output: 'json:' + msg.prompt + ':' + String(msg.hidden) }) + '\\n');
    }
    idx = buffer.indexOf('\\n');
  }
});
`
    : `
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) process.stdout.write('stdio:' + line + '\\n');
    idx = buffer.indexOf('\\n');
  }
});
`;
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function hostedRuntimeOverride(fakeAgent: string, protocol: 'line-json' | 'stdio') {
  return {
    runtime: {
      backend: 'hosted' as const,
      maxLive: 0,
      archiveOnDispose: true,
      archiveMaxMB: 64,
      archiveKeep: 20,
      jitSecrets: false,
      jitSecretTtlMs: 60_000,
      containerImage: '',
      container: { cpus: 0, memory: '' },
      serve: false,
      serveHost: '127.0.0.1',
      servePort: 8791,
      remoteUrl: '',
      previewPorts: {},
    },
    agents: {
      hosted: [{ name: 'fake', command: process.execPath, args: [fakeAgent], protocol }],
    },
  };
}

test('hosted CLI runtime starts, frames JSON turns, and stops a fake agent', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const fake = writeFakeAgent(ws, 'line-json');
    const runtime = createHostedCliRuntime({
      config: { name: 'fake', command: process.execPath, args: [fake], protocol: 'line-json' },
      id: 'rt_hosted_json',
    });
    await runtime.start({ workspaceRoot: ws, sessionKey: 'session:hosted' });
    assert.equal(runtime.status(), 'ready');
    assert.equal((await runtime.exec({ prompt: 'hello', hidden: true })).output, 'json:hello:true');
    await runtime.dispose();
    assert.equal(runtime.status(), 'disposed');
  });
});

test('runtime manager can resolve a config-declared hosted CLI backend', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const fake = writeFakeAgent(ws, 'line-json');
    _resetCliKnobsCache();
    setCliKnobOverride(hostedRuntimeOverride(fake, 'line-json'));
    try {
      const manager = new RuntimeManager({ workspaceRoot: ws, executeTurn: async () => 'unused' });
      const runtime = await manager.start({ sessionKey: 'session:manager', role: 'fake' });
      assert.equal(runtime.kind, 'hosted');
      assert.equal((await manager.exec(runtime.id, { prompt: 'ping' })).output, 'json:ping:false');
      await runtime.dispose();
    } finally {
      _resetCliKnobsCache();
    }
  });
});

test('hosted CLI runtime supports plain stdio line framing', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const fake = writeFakeAgent(ws, 'stdio');
    const runtime = createHostedCliRuntime({
      config: { name: 'fake', command: process.execPath, args: [fake], protocol: 'stdio' },
      id: 'rt_hosted_stdio',
    });
    await runtime.start({ workspaceRoot: ws, sessionKey: 'session:stdio' });
    assert.equal((await runtime.exec({ prompt: 'plain' })).output, 'stdio:plain');
    await runtime.dispose();
  });
});
