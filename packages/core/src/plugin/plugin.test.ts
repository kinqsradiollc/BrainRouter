/**
 * PLUGIN-MARKETPLACE P1 — plugin core tests.
 *
 * Covers manifest validation, a fixture plugin loading every inert contribution
 * kind into the aggregate, safeMode skipping loading entirely, and atomic
 * install behavior. All state is confined to a temp `BRAINROUTER_HOME` + temp
 * workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateManifest,
  parseManifest,
  expandPluginRoot,
  loadPlugins,
  readPluginMcpServers,
  installPlugin,
  removePlugin,
  classifySource,
  scaffoldPlugin,
  setPluginEnabledIn,
  userPluginsDir,
  workspacePluginsDir,
} from './index.js';
import type { Config } from '../config/configTypes.js';

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Write a full fixture plugin at <dir>/<name>. */
function writeFixturePlugin(dir: string, name: string): string {
  const root = path.join(dir, name);
  const w = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  w('.brainrouter-plugin/plugin.json', JSON.stringify({
    name,
    version: '1.0.0',
    description: 'fixture',
    category: 'development',
    keywords: ['test'],
    compatibility: { brainrouterVersion: '>=0.4.17', agentApiVersion: '1' },
  }));
  w('skills/demo/SKILL.md', `---\nname: ${name}-demo\ndescription: demo skill\n---\n# demo\n`);
  w('personas/helper.json', JSON.stringify({
    schemaVersion: 1,
    kind: 'persona',
    id: 'helper',
    displayName: 'Helper',
    description: 'Fixture persona',
    instructions: ['Help with the requested task.'],
  }));
  w('agents/helper.md', '# helper agent\n');
  w('orchestration-profiles/helper.json', '{}\n');
  w('commands/greet.md', 'Say hi to $ARGUMENTS\n');
  w('hooks/hooks.json', JSON.stringify({ hooks: [{ event: 'pre-tool', command: 'echo hi' }] }));
  w('mcp.json', JSON.stringify({ mcpServers: { local: { type: 'stdio', command: '${BRAINROUTER_PLUGIN_ROOT}/server.js', args: ['--root', '${BRAINROUTER_PLUGIN_ROOT}'] } } }));
  return root;
}

const baseCfg = (cli: Record<string, unknown> = {}): Config => ({ activeServer: '', servers: {}, cli } as Config);

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

test('validateManifest: accepts a minimal name-only manifest', () => {
  const r = validateManifest({ name: 'acme-devkit' });
  assert.equal(r.valid, true);
  assert.equal(r.manifest?.name, 'acme-devkit');
});

test('validateManifest: rejects a missing name', () => {
  const r = validateManifest({ version: '1.0.0' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('name is required')));
});

test('validateManifest: rejects a non-kebab-case name', () => {
  const r = validateManifest({ name: 'Acme_DevKit' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('kebab-case')));
});

test('validateManifest: warns (not errors) on a bad category + version', () => {
  const r = validateManifest({ name: 'ok-name', category: 'nonsense', version: 42 });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('category')));
  assert.ok(r.warnings.some((w) => w.includes('version')));
});

test('validateManifest: rejects an escaping contributes path', () => {
  const r = validateManifest({ name: 'ok-name', contributes: { skills: '../evil' } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('relative path inside the plugin')));
});

test('parseManifest: reports a JSON syntax error as a hard error', () => {
  const r = parseManifest('{ not json');
  assert.equal(r.valid, false);
  assert.ok(r.errors[0].includes('invalid JSON'));
});

test('expandPluginRoot: substitutes both token forms', () => {
  assert.equal(expandPluginRoot('${BRAINROUTER_PLUGIN_ROOT}/x', '/p'), '/p/x');
  assert.equal(expandPluginRoot('$BRAINROUTER_PLUGIN_ROOT/y', '/p'), '/p/y');
});

test('classifySource: distinguishes local paths from git urls', () => {
  assert.equal(classifySource('./local/plugin'), 'local');
  assert.equal(classifySource('/abs/path'), 'local');
  assert.equal(classifySource('https://github.com/u/r.git'), 'git');
  assert.equal(classifySource('git+https://github.com/u/r.git#v1'), 'git');
  assert.equal(classifySource('git@github.com:u/r.git'), 'git');
});

// ---------------------------------------------------------------------------
// Loader — fixture plugin feeds the subsystems
// ---------------------------------------------------------------------------

test('loadPlugins: an enabled fixture plugin contributes every declared component', (t) => {
  const home = mkTmp('br-plug-home-');
  const ws = mkTmp('br-plug-ws-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  writeFixturePlugin(userPluginsDir(), 'acme-devkit');

  // Disabled by default → nothing loads.
  const off = loadPlugins(ws, baseCfg());
  assert.equal(off.loaded.length, 0);
  assert.equal(off.disabled.length, 1);
  assert.equal(off.disabled[0].name, 'acme-devkit');

  // Enable it → inert contributions populate; hooks + MCP are gated behind the
  // P3 consent model, so grant shell + MCP too to see the full surface.
  const cfg = baseCfg({ plugins: { enabled: { 'acme-devkit': true }, approved: { 'acme-devkit': { shell: true, mcp: true } } } });
  const on = loadPlugins(ws, cfg);
  assert.equal(on.loaded.length, 1);
  const p = on.loaded[0];
  assert.equal(p.scope, 'user');
  assert.deepEqual({
    skills: p.provides.skills,
    personas: p.provides.personas,
    agents: p.provides.agents,
    orchestrationProfiles: p.provides.orchestrationProfiles,
    commands: p.provides.commands,
    hooks: p.provides.hooks,
    mcpServers: p.provides.mcpServers,
  }, {
    skills: 1,
    personas: 1,
    agents: 1,
    orchestrationProfiles: 1,
    commands: 1,
    hooks: 1,
    mcpServers: 1,
  });
  assert.deepEqual(
    on.contributions.orchestrationProfileFiles.map((entry) => path.basename(entry.path)),
    ['helper.json'],
  );
  assert.equal(on.contributions.skillRoots.length, 1);
  assert.ok(on.contributions.skillRoots[0].endsWith(path.join('acme-devkit', 'skills')));
  assert.equal(on.contributions.personaFiles.length, 1);
  assert.equal(on.contributions.agentFiles.length, 1);
  assert.equal(on.contributions.commandFiles.length, 1);
  assert.equal(on.contributions.hookFiles.length, 1);
  assert.equal(on.contributions.mcpConfigFiles.length, 1);

  // MCP server ids are namespaced + ${BRAINROUTER_PLUGIN_ROOT} is expanded.
  const servers = readPluginMcpServers(on.contributions.mcpConfigFiles[0]);
  const key = Object.keys(servers)[0];
  assert.equal(key, 'acme-devkit:local');
  const s = servers[key] as { command: string; args: string[] };
  assert.ok(s.command.startsWith(p.root));
  assert.ok(!s.command.includes('${BRAINROUTER_PLUGIN_ROOT}'));
  assert.equal(s.args[1], p.root);
});

test('loadPlugins: safeMode skips loading entirely', (t) => {
  const home = mkTmp('br-plug-home-');
  const ws = mkTmp('br-plug-ws-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  writeFixturePlugin(userPluginsDir(), 'acme-devkit');
  const cfg = baseCfg({ safeMode: true, plugins: { enabled: { 'acme-devkit': true } } });
  const r = loadPlugins(ws, cfg);
  assert.equal(r.skippedForSafeMode, true);
  assert.equal(r.loaded.length, 0);
  assert.equal(r.disabled.length, 0);
  assert.equal(r.contributions.skillRoots.length, 0);
});

test('loadPlugins: workspace scope overrides user scope for the same name', (t) => {
  const home = mkTmp('br-plug-home-');
  const ws = mkTmp('br-plug-ws-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  writeFixturePlugin(userPluginsDir(), 'dup-plugin');
  writeFixturePlugin(workspacePluginsDir(ws), 'dup-plugin');
  const cfg = baseCfg({ plugins: { enabled: { 'dup-plugin': true } } });
  const r = loadPlugins(ws, cfg);
  assert.equal(r.loaded.length, 1);
  assert.equal(r.loaded[0].scope, 'workspace');
});

test('loadPlugins: an invalid plugin surfaces an error but does not throw', (t) => {
  const home = mkTmp('br-plug-home-');
  const ws = mkTmp('br-plug-ws-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  const bad = path.join(userPluginsDir(), 'broken');
  fs.mkdirSync(path.join(bad, '.brainrouter-plugin'), { recursive: true });
  fs.writeFileSync(path.join(bad, '.brainrouter-plugin', 'plugin.json'), '{ "name": "Bad Name" }');
  const r = loadPlugins(ws, baseCfg());
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].includes('kebab-case'));
});

// ---------------------------------------------------------------------------
// Install — atomic staging
// ---------------------------------------------------------------------------

test('installPlugin: installs a local plugin + writes install.json', (t) => {
  const home = mkTmp('br-plug-home-');
  const src = mkTmp('br-plug-src-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  });

  const pluginSrc = writeFixturePlugin(src, 'acme-devkit');
  const r = installPlugin(pluginSrc, { scope: 'user' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.name, 'acme-devkit');
  assert.ok(fs.existsSync(path.join(r.installedTo, 'install.json')));
  const rec = JSON.parse(fs.readFileSync(path.join(r.installedTo, 'install.json'), 'utf8'));
  assert.equal(rec.sourceType, 'local');
  assert.equal(rec.scope, 'user');
  // No leftover staging dirs.
  const staging = path.join(userPluginsDir(), '.staging');
  const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  assert.deepEqual(leftovers, []);
});

test('installPlugin: a failed install leaves the prior live copy intact (atomic)', (t) => {
  const home = mkTmp('br-plug-home-');
  const src = mkTmp('br-plug-src-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  });

  // Install a good v1.
  const good = writeFixturePlugin(src, 'acme-devkit');
  const first = installPlugin(good, { scope: 'user' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const liveManifest = path.join(first.installedTo, '.brainrouter-plugin', 'plugin.json');
  const v1 = fs.readFileSync(liveManifest, 'utf8');
  assert.equal(JSON.parse(v1).version, '1.0.0');

  // Attempt to install a BROKEN plugin of the same name (invalid manifest).
  const badDir = path.join(src, 'broken-acme');
  fs.mkdirSync(path.join(badDir, '.brainrouter-plugin'), { recursive: true });
  fs.writeFileSync(path.join(badDir, '.brainrouter-plugin', 'plugin.json'), '{ "name": "Not Kebab" }');
  const second = installPlugin(badDir, { scope: 'user', force: true });
  assert.equal(second.ok, false);

  // The live v1 copy must be untouched.
  assert.equal(fs.readFileSync(liveManifest, 'utf8'), v1);
  // And no staging leftovers.
  const staging = path.join(userPluginsDir(), '.staging');
  const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  assert.deepEqual(leftovers, []);
});

test('installPlugin: refuses to overwrite without force', (t) => {
  const home = mkTmp('br-plug-home-');
  const src = mkTmp('br-plug-src-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  });

  const p = writeFixturePlugin(src, 'acme-devkit');
  assert.equal(installPlugin(p, { scope: 'user' }).ok, true);
  const again = installPlugin(p, { scope: 'user' });
  assert.equal(again.ok, false);
  if (!again.ok) assert.ok(again.error.includes('already installed'));
});

test('removePlugin: removes an installed plugin', (t) => {
  const home = mkTmp('br-plug-home-');
  const src = mkTmp('br-plug-src-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  });

  const p = writeFixturePlugin(src, 'acme-devkit');
  const inst = installPlugin(p, { scope: 'user' });
  assert.equal(inst.ok, true);
  if (!inst.ok) return;
  const rm = removePlugin('acme-devkit', { scope: 'user' });
  assert.equal(rm.ok, true);
  assert.ok(!fs.existsSync(inst.installedTo));
  assert.equal(removePlugin('acme-devkit', { scope: 'user' }).ok, false);
});

// ---------------------------------------------------------------------------
// Scaffold + service
// ---------------------------------------------------------------------------

test('scaffoldPlugin: writes a valid skeleton that discovers', (t) => {
  const dir = mkTmp('br-plug-scaffold-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = scaffoldPlugin('my-kit', dir);
  assert.equal(r.ok, true);
  if (!r.ok || !r.root) return;
  const manifest = parseManifest(fs.readFileSync(path.join(r.root, '.brainrouter-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.valid, true);
  assert.equal(manifest.manifest?.name, 'my-kit');
  // Refuses to overwrite.
  assert.equal(scaffoldPlugin('my-kit', dir).ok, false);
});

test('setPluginEnabledIn: flips the enable flag immutably', () => {
  const cfg = baseCfg();
  const on = setPluginEnabledIn(cfg, 'acme-devkit', true);
  assert.equal(on.cli?.plugins?.enabled?.['acme-devkit'], true);
  const off = setPluginEnabledIn(on, 'acme-devkit', false);
  assert.equal(off.cli?.plugins?.enabled?.['acme-devkit'], false);
  // Original untouched.
  assert.equal(cfg.cli?.plugins, undefined);
});
