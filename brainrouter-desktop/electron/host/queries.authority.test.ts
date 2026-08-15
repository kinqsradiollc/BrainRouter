import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isExtensionEnabled } from '@kinqs/brainrouter-core/extension';
import { addHook, readHooks } from '@kinqs/brainrouter-core/hooks';
import {
  getSessionMode,
  readPreferences,
  writePreferences,
} from '@kinqs/brainrouter-core/session';
import { isWorkspaceTrusted } from '@kinqs/brainrouter-core/workspace';
import type { HostContext } from './context.js';
import { buildQueries } from './queries.js';

function hostContext(values: Record<PropertyKey, unknown>): HostContext {
  const fallback = () => undefined;
  return new Proxy(values, {
    get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : fallback,
  }) as unknown as HostContext;
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

test('reviewed-policy query writes synchronously revoke on both sides of A to B to A changes', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-desktop-authority-'));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const previousHome = process.env.BRAINROUTER_HOME;
  fs.mkdirSync(workspaceRoot, { recursive: true });
  process.env.BRAINROUTER_HOME = path.join(tempRoot, 'home');

  try {
    writePreferences(workspaceRoot, {
      delegationPolicy: 'auto',
      executionMode: 'planning',
      reviewPolicy: 'request',
      effort: 'medium',
    });
    const hook = addHook(workspaceRoot, { event: 'pre-tool', command: 'true' });
    const sessionKey = 'sess:authority';
    let action = '';
    const observed: Array<{
      action: string;
      scope: 'active-session' | 'workspace';
      delegationPolicy: unknown;
      sessionMode: ReturnType<typeof getSessionMode>;
      hookEnabled: boolean | undefined;
      accessMode: 'read' | 'write' | 'shell';
    }> = [];
    let accessMode: 'read' | 'write' | 'shell' = 'shell';
    const agent = {
      sessionKey,
      refreshSystemPrompt: () => undefined,
      getAccessMode: () => accessMode,
      setAccessMode: (next: 'read' | 'write' | 'shell') => { accessMode = next; },
    };
    const ctx = hostContext({
      ghJson: async () => ({}),
      workspaceRoot,
      wsGit: {},
      collectWorkingDiff: async () => ({ diff: '', files: [] }),
      getActiveAgent: () => agent,
      revokeReviewedExecutionAuthority: (scope: 'active-session' | 'workspace') => {
        observed.push({
          action,
          scope,
          delegationPolicy: readPreferences(workspaceRoot).delegationPolicy,
          sessionMode: getSessionMode(workspaceRoot, sessionKey),
          hookEnabled: readHooks(workspaceRoot).find((candidate) => candidate.id === hook.id)?.enabled,
          accessMode,
        });
      },
    });
    const queries = buildQueries(ctx);

    action = 'pref:B';
    await queries['action:set-pref']!({ key: 'delegationPolicy', value: 'no-children' });
    action = 'pref:A';
    await queries['action:set-pref']!({ key: 'delegationPolicy', value: 'auto' });
    action = 'mode:B';
    await queries['action:set-session-mode']!({ executionMode: 'fast', reviewPolicy: 'proceed' });
    action = 'mode:A';
    await queries['action:set-session-mode']!({ executionMode: 'planning', reviewPolicy: 'request' });
    action = 'access:B';
    await queries['action:set-access']!({ mode: 'read' });
    action = 'access:A';
    await queries['action:set-access']!({ mode: 'shell' });
    action = 'hook:B';
    await queries['action:set-hook']!({ id: hook.id, enabled: false });
    action = 'hook:A';
    await queries['action:set-hook']!({ id: hook.id, enabled: true });

    assert.deepEqual(observed.map(({ action: name, scope }) => [name, scope]), [
      ['pref:B', 'workspace'],
      ['pref:A', 'workspace'],
      ['mode:B', 'active-session'],
      ['mode:A', 'active-session'],
      ['access:B', 'active-session'],
      ['access:A', 'active-session'],
      ['hook:B', 'workspace'],
      ['hook:A', 'workspace'],
    ]);
    assert.deepEqual(observed.slice(0, 2).map(({ delegationPolicy }) => delegationPolicy), [
      'auto',
      'no-children',
    ], 'preference authority is revoked before either durable write');
    assert.deepEqual(observed.slice(2, 4).map(({ sessionMode }) => sessionMode), [
      {},
      { executionMode: 'fast', reviewPolicy: 'proceed' },
    ], 'session authority is revoked before either per-session mode write');
    assert.deepEqual(observed.slice(4, 6).map(({ accessMode: current }) => current), ['shell', 'read'],
      'access authority is revoked before either Agent mutation');
    assert.deepEqual(observed.slice(6).map(({ hookEnabled }) => hookEnabled), [true, false],
      'hook authority is revoked before either enablement write');

    const revocations = observed.length;
    await queries['action:set-pref']!({ key: 'delegationPolicy', value: 'auto' });
    await queries['action:set-session-mode']!({ executionMode: 'planning', reviewPolicy: 'request' });
    await queries['action:set-access']!({ mode: 'shell' });
    await queries['action:set-hook']!({ id: hook.id, enabled: true });
    assert.equal(observed.length, revocations, 'effective no-op writes do not rotate reviewed authority');
  } finally {
    restoreEnv('BRAINROUTER_HOME', previousHome);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('MCP and extension mutations revoke workspace authority before catalog mutation or reload', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-desktop-catalog-authority-'));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const configDir = path.join(tempRoot, 'config');
  const configPath = path.join(configDir, 'config.json');
  const previousHome = process.env.BRAINROUTER_HOME;
  const previousConfigDir = process.env.BRAINROUTER_CONFIG_DIR;
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  process.env.BRAINROUTER_HOME = path.join(tempRoot, 'home');
  process.env.BRAINROUTER_CONFIG_DIR = configDir;
  fs.writeFileSync(configPath, JSON.stringify({
    activeServer: 'alpha',
    servers: {
      alpha: { type: 'http', url: 'https://alpha.invalid/mcp' },
      beta: { type: 'http', url: 'https://beta.invalid/mcp' },
    },
  }));

  try {
    let action = '';
    const lifecycle: string[] = [];
    const observed: Array<{
      action: string;
      activeServer?: string;
      hasGamma: boolean;
      extensionEnabled: boolean;
      workspaceTrusted: boolean;
    }> = [];
    const readConfig = (): { activeServer?: string; servers?: Record<string, unknown> } => (
      JSON.parse(fs.readFileSync(configPath, 'utf8')) as { activeServer?: string; servers?: Record<string, unknown> }
    );
    const ctx = hostContext({
      ghJson: async () => ({}),
      workspaceRoot,
      wsGit: {},
      collectWorkingDiff: async () => ({ diff: '', files: [] }),
      getActiveAgent: () => ({ sessionKey: 'sess:catalog' }),
      getLlm: () => undefined,
      revokeReviewedExecutionAuthority: (scope: 'active-session' | 'workspace') => {
        assert.equal(scope, 'workspace');
        const config = readConfig();
        lifecycle.push(`revoke:${action}`);
        observed.push({
          action,
          activeServer: config.activeServer,
          hasGamma: !!config.servers?.gamma,
          extensionEnabled: isExtensionEnabled('test-authority-extension'),
          workspaceTrusted: isWorkspaceTrusted(workspaceRoot),
        });
      },
      mcpClient: {
        reconnectOne: async (id: string) => { lifecycle.push(`reconnect:${id}`); },
        connectOne: async (id: string) => { lifecycle.push(`connect:${id}`); },
        disconnectOne: async (id: string) => { lifecycle.push(`disconnect:${id}`); },
      },
    });
    const queries = buildQueries(ctx);

    action = 'reconnect:alpha';
    await queries['action:reconnect-mcp']!({ id: 'alpha' });
    action = 'active:B';
    await queries['action:set-active-server']!({ id: 'beta' });
    action = 'active:A';
    await queries['action:set-active-server']!({ id: 'alpha' });
    action = 'add:gamma';
    await queries['action:add-mcp']!({ id: 'gamma', type: 'http', url: 'https://gamma.invalid/mcp' });
    action = 'remove:gamma';
    await queries['action:remove-mcp']!({ id: 'gamma' });
    action = 'extension:B';
    await queries['action:ext-set-enabled']!({ name: 'test-authority-extension', enabled: false });
    action = 'extension:A';
    await queries['action:ext-set-enabled']!({ name: 'test-authority-extension', enabled: true });
    action = 'trust:B';
    await queries['action:trust-workspace']!({ trusted: true });
    action = 'trust:A';
    await queries['action:trust-workspace']!({ trusted: false });

    assert.deepEqual(lifecycle.slice(0, 10), [
      'revoke:reconnect:alpha', 'reconnect:alpha',
      'revoke:active:B', 'reconnect:beta',
      'revoke:active:A', 'reconnect:alpha',
      'revoke:add:gamma', 'connect:gamma',
      'revoke:remove:gamma', 'disconnect:gamma',
    ], 'each MCP admission fence runs before the first client-side mutation await');
    assert.deepEqual(observed.filter(({ action: name }) => name.startsWith('active:'))
      .map(({ activeServer }) => activeServer), ['alpha', 'beta']);
    assert.equal(observed.find(({ action: name }) => name === 'add:gamma')?.hasGamma, false);
    assert.equal(observed.find(({ action: name }) => name === 'remove:gamma')?.hasGamma, true);
    assert.deepEqual(observed.filter(({ action: name }) => name.startsWith('extension:'))
      .map(({ extensionEnabled }) => extensionEnabled), [true, false]);
    assert.deepEqual(observed.filter(({ action: name }) => name.startsWith('trust:'))
      .map(({ workspaceTrusted }) => workspaceTrusted), [false, true]);

    const revocations = observed.length;
    assert.deepEqual(await queries['action:reconnect-mcp']!({ id: 'missing' }), {
      ok: false,
      error: 'No configured server named "missing".',
    });
    assert.deepEqual(await queries['action:set-active-server']!({ id: 'missing' }), {
      ok: false,
      error: 'No configured server named "missing".',
    });
    assert.deepEqual(await queries['action:add-mcp']!({ id: 'bad id', type: 'http', url: 'https://bad.invalid' }), {
      ok: false,
      error: 'Server id must be letters, digits, dash, underscore or dot.',
    });
    assert.deepEqual(await queries['action:remove-mcp']!({ id: 'missing' }), {
      ok: false,
      error: 'No configured server named "missing".',
    });
    assert.equal(observed.length, revocations, 'invalid or missing MCP targets do not revoke authority');
  } finally {
    restoreEnv('BRAINROUTER_HOME', previousHome);
    restoreEnv('BRAINROUTER_CONFIG_DIR', previousConfigDir);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
