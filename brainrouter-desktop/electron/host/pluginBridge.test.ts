/**
 * PLUGIN-MARKETPLACE P4-desktop — host plugin-bridge tests.
 *
 * Exercises the real bridge (which delegates to the shared core plugin runtime)
 * over an isolated `BRAINROUTER_HOME` temp dir, so install / list / remove /
 * consent round-trip without touching the machine's real plugin store. The
 * registry fetch inside listInstalledPlugins is stubbed to avoid a network call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the plugin store BEFORE importing the bridge (brainrouterHome() reads
// BRAINROUTER_HOME live, so this redirects install/list/remove to a temp dir).
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-bridge-')));
process.env.BRAINROUTER_HOME = HOME;

// Stub fetch so the best-effort registry lookup never hits the network.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('offline (test stub)'); }) as typeof fetch;

const {
  installPluginFromSource,
  listInstalledPlugins,
  pluginConsentSummary,
  removePluginBridge,
} = await import('./pluginBridge.js');

/** Write a minimal skills-only plugin (safe: no shell/MCP capabilities). */
function writeFixturePlugin(root: string, name: string): void {
  fs.mkdirSync(path.join(root, '.brainrouter-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.brainrouter-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', description: 'fixture', category: 'development', author: { name: 'Tester' } }, null, 2),
  );
  fs.mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), '# demo skill\n');
}

/** Write a plugin whose hooks run a shell command (needs consent). */
function writeRiskyPlugin(root: string, name: string): void {
  fs.mkdirSync(path.join(root, '.brainrouter-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.brainrouter-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '2.0.0', description: 'risky', category: 'security' }, null, 2),
  );
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${BRAINROUTER_PLUGIN_ROOT}/scan.sh' }] }] }, null, 2),
  );
}

test('install from a local source, then list finds it (disabled by default)', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-src-'));
  writeFixturePlugin(src, 'bridge-demo');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-ws-'));

  const inst = installPluginFromSource(src, { scope: 'user', workspaceRoot: ws });
  assert.equal(inst.ok, true);
  assert.equal(inst.name, 'bridge-demo');

  const listed = await listInstalledPlugins(ws);
  const found = listed.plugins.find((p) => p.name === 'bridge-demo');
  assert.ok(found, 'installed plugin appears in the list');
  assert.equal(found!.version, '1.0.0');
  assert.equal(found!.author, 'Tester');
  assert.equal(found!.provides.skills, 1);
  assert.equal(found!.requiresConsent, false, 'a skills-only plugin needs no consent');
  assert.equal(found!.enabled, false, 'plugins default disabled');
});

test('consent summary flags a plugin that ships a shell hook', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-src-'));
  writeRiskyPlugin(src, 'bridge-risky');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-ws-'));

  const inst = installPluginFromSource(src, { scope: 'user', workspaceRoot: ws });
  assert.equal(inst.ok, true);

  const res = await pluginConsentSummary('bridge-risky', ws, 'user');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.summary.requiresConsent, true, 'a command hook requires consent');
  assert.equal(res.summary.hookCommands.length, 1);
  assert.ok(res.summary.hookCommands[0].command.includes('scan.sh'));
  // ${BRAINROUTER_PLUGIN_ROOT} must have been expanded to an absolute path.
  assert.ok(!res.summary.hookCommands[0].command.includes('${BRAINROUTER_PLUGIN_ROOT}'));
});

test('remove deletes an installed plugin', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-src-'));
  writeFixturePlugin(src, 'bridge-remove');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-ws-'));

  installPluginFromSource(src, { scope: 'user', workspaceRoot: ws });
  const before = await listInstalledPlugins(ws);
  assert.ok(before.plugins.some((p) => p.name === 'bridge-remove'));

  const rm = removePluginBridge('bridge-remove', { scope: 'user', workspaceRoot: ws });
  assert.equal(rm.ok, true);

  const after = await listInstalledPlugins(ws);
  assert.equal(after.plugins.some((p) => p.name === 'bridge-remove'), false);
});

test.after(() => {
  globalThis.fetch = realFetch;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
});
