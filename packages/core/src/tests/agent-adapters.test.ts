import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_ADAPTERS,
  buildAdapterLaunchPlan,
  createAdapterIntegrationPlan,
  detectAgentAdapters,
  installNativeAgentHooks,
  installStaticMcpConfig,
  normalizeHostedAgentHook,
  statusFromTerminalOutput,
} from '../agent/adapters/index.js';

test('catalog contains one declarative row for every supported runtime', () => {
  assert.deepEqual(AGENT_ADAPTERS.map((adapter) => adapter.id), [
    'brainrouter', 'claude-code', 'codex', 'opencode', 'gemini-cli',
  ]);
  for (const adapter of AGENT_ADAPTERS) {
    assert.ok(adapter.command);
    assert.ok(adapter.controls.interrupt);
    assert.ok(adapter.integration.hookEvents.length > 0);
  }
});

test('launch planning enforces trust without putting prompts in argv', () => {
  const denied = buildAdapterLaunchPlan({ adapterId: 'codex', executable: '/bin/codex', prompt: 'secret prompt', sessionKey: 's1' });
  assert.equal(denied.error, 'trust-required');

  const plan = buildAdapterLaunchPlan({ adapterId: 'codex', executable: '/bin/codex', prompt: 'secret prompt', trusted: true, sessionKey: 's1' });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.args, []);
  assert.equal(plan.initialInput, 'secret prompt\r');
  assert.ok(!JSON.stringify(plan.args).includes('secret prompt'));
});

test('resume arguments and integration plans stay adapter-specific and secret-free', () => {
  const plan = buildAdapterLaunchPlan({ adapterId: 'claude-code', executable: '/bin/claude', resumeSessionId: 'abc', trusted: true, sessionKey: 's1' });
  assert.deepEqual(plan.args, ['--resume', 'abc']);
  const integration = createAdapterIntegrationPlan('claude-code');
  assert.equal(integration.mcp?.command, 'claude');
  assert.ok(integration.mcp?.args.includes('mcp-proxy'));
  assert.doesNotMatch(JSON.stringify(integration), /api[_-]?key|token/i);
});

test('executable detection records only installed catalog commands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-adapters-'));
  const command = path.join(dir, 'codex');
  fs.writeFileSync(command, '#!/bin/sh\n');
  fs.chmodSync(command, 0o755);
  const rows = detectAgentAdapters({ path: dir, platform: 'darwin' });
  assert.equal(rows.find((row) => row.id === 'codex')?.installed, true);
  assert.equal(rows.find((row) => row.id === 'claude-code')?.installed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recorded hook and terminal signals normalize to shared statuses', () => {
  assert.equal(normalizeHostedAgentHook({ adapterId: 'opencode', event: 'session.idle' }), 'done');
  assert.equal(normalizeHostedAgentHook({ adapterId: 'gemini-cli', event: 'Notification', message: 'approval needed' }), 'blocked');
  assert.equal(statusFromTerminalOutput('Allow this command?'), 'blocked');
  assert.equal(statusFromTerminalOutput('fatal: auth failed'), 'failed');
});

test('native hook setup merges project-local settings without credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-hooks-'));
  const configDir = path.join(dir, '.claude');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
  const result = installNativeAgentHooks(dir, 'claude-code');
  assert.equal(result.installed, true);
  const stored = JSON.parse(fs.readFileSync(result.path!, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(stored.permissions, { allow: ['Read'] });
  assert.ok((stored.hooks as Record<string, unknown>).PreToolUse);
  assert.doesNotMatch(JSON.stringify(stored), /api[_-]?key|token/i);
  if (process.platform !== 'win32') assert.equal(fs.statSync(result.path!).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('static MCP setup merges OpenCode config without replacing user settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-opencode-'));
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ theme: 'system', mcp: { other: { type: 'remote', url: 'http://localhost' } } }));
  const result = installStaticMcpConfig(dir, 'opencode');
  const stored = JSON.parse(fs.readFileSync(result.path!, 'utf8')) as { theme: string; mcp: Record<string, unknown> };
  assert.equal(stored.theme, 'system');
  assert.ok(stored.mcp.other);
  assert.deepEqual(stored.mcp.brainrouter, { type: 'local', command: ['brainrouter', 'mcp-proxy'], enabled: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
