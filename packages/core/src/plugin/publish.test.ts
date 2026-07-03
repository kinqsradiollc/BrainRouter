/**
 * PLUGIN-MARKETPLACE P5 — publish + auto-update + per-plugin config tests.
 *
 * Covers:
 *  - publish computes the correct integrity + emits a valid registry entry (that
 *    round-trips through the registry validator);
 *  - publish falls back to a local file + gh instructions when no publishRepo;
 *  - update bumps a pinned fixture plugin's version AND preserves enabled state;
 *  - update reports "already up to date" at the same version;
 *  - auto-update-check SURFACES (never installs) an available update;
 *  - per-plugin `<name>.local.md` is parsed (frontmatter + body).
 *
 * All state is confined to a temp `BRAINROUTER_HOME` + temp workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildRegistryEntry,
  planPublish,
  normalizePublishRepo,
  writeRegistryEntryFile,
  validateRegistryIndex,
  hashDirectory,
  installPlugin,
  updatePlugin,
  updatePlugins,
  setPluginEnabled,
  isPluginEnabled,
  computeAvailableUpdates,
  isNewerVersion,
  formatUpdateNotice,
  runAutoUpdateCheck,
  readPluginLocalConfig,
  pluginLocalConfigPath,
  listInstalledPlugins,
  workspacePluginsDir,
  userPluginsDir,
} from './index.js';
import { loadOrInitConfig } from '../config/config.js';
import type { RegistryIndex } from './registry.js';

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Write a plugin folder at <dir> with a given name + version + a starter skill. */
function writePlugin(root: string, name: string, version = '1.0.0'): void {
  const w = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  w('.brainrouter-plugin/plugin.json', JSON.stringify({
    name,
    version,
    description: 'fixture plugin',
    category: 'development',
    keywords: ['demo', 'test'],
    repository: 'git+https://github.com/acme/acme-devkit.git',
    author: { name: 'Acme' },
  }));
  w('skills/demo/SKILL.md', `---\nname: ${name}-demo\ndescription: demo\n---\n# demo\n`);
  w('agents/helper.md', '# helper\n');
}

// ---------------------------------------------------------------------------
// publish — integrity + registry entry
// ---------------------------------------------------------------------------

test('publish: buildRegistryEntry computes the correct tree integrity + a valid entry', () => {
  const dir = mkTmp('br-pub-');
  const root = path.join(dir, 'acme-devkit');
  writePlugin(root, 'acme-devkit', '1.2.0');

  const built = buildRegistryEntry(root, { now: new Date('2026-07-03T00:00:00Z') });
  assert.ok(built.ok);
  if (!built.ok) return;

  // Integrity is the deterministic tree digest — recompute + compare.
  const expected = hashDirectory(root);
  assert.equal(built.integrity, expected);
  assert.match(built.entry.integrity ?? '', /^sha256-/);

  // Entry carries the manifest-derived fields.
  assert.equal(built.entry.id, 'acme-devkit');
  assert.equal(built.entry.version, '1.2.0');
  assert.equal(built.entry.category, 'development');
  assert.equal(built.entry.repo, 'git+https://github.com/acme/acme-devkit.git');
  assert.deepEqual(built.entry.tags, ['demo', 'test']);
  assert.equal(built.entry.lastUpdated, '2026-07-03');
  assert.equal(built.entry.provides.skills, 1);
  assert.equal(built.entry.provides.agents, 1);

  // The emitted entry round-trips through the registry index validator.
  const idx = validateRegistryIndex({ plugins: [built.entry] });
  assert.equal(idx.valid, true);
  assert.equal(idx.index?.plugins[0].id, 'acme-devkit');
  assert.equal(idx.index?.plugins[0].integrity, built.integrity);
});

test('publish: planPublish with a publishRepo emits gh PR instructions', () => {
  const dir = mkTmp('br-pub-');
  const root = path.join(dir, 'acme-devkit');
  writePlugin(root, 'acme-devkit', '1.2.0');

  const res = planPublish(root, { publishRepo: 'kinqsradio/brainrouter-plugins', now: new Date('2026-07-03T00:00:00Z') });
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.plan.publishRepo, 'kinqsradio/brainrouter-plugins');
  assert.equal(res.plan.branch, 'plugin-publish/acme-devkit-1-2-0');
  assert.ok(res.plan.instructions.some((l) => l.includes('gh pr create')));
  assert.ok(res.plan.instructions.some((l) => l.includes('kinqsradio/brainrouter-plugins')));
});

test('publish: no publishRepo → writes a local file + prints the local fallback', () => {
  const dir = mkTmp('br-pub-');
  const root = path.join(dir, 'acme-devkit');
  writePlugin(root, 'acme-devkit', '1.2.0');

  const res = planPublish(root, {});
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.plan.publishRepo, '');
  assert.equal(res.plan.localFile, path.join(root, 'registry-entry.json'));
  assert.ok(res.plan.instructions.some((l) => l.includes('publishRepo')));

  const write = writeRegistryEntryFile(res.plan);
  assert.ok(write.ok);
  const onDisk = JSON.parse(fs.readFileSync(res.plan.localFile, 'utf8'));
  assert.equal(onDisk.id, 'acme-devkit');
  assert.equal(onDisk.integrity, res.plan.integrity);
});

test('publish: an invalid plugin dir fails', () => {
  const dir = mkTmp('br-pub-');
  const res = planPublish(dir, {});
  assert.equal(res.ok, false);
});

test('normalizePublishRepo: accepts owner/repo + a github url', () => {
  assert.equal(normalizePublishRepo('kinqsradio/brainrouter-plugins'), 'kinqsradio/brainrouter-plugins');
  assert.equal(normalizePublishRepo('https://github.com/kinqsradio/brainrouter-plugins.git'), 'kinqsradio/brainrouter-plugins');
  assert.equal(normalizePublishRepo('git+https://github.com/a/b.git#main'), 'a/b');
});

// ---------------------------------------------------------------------------
// update — version bump + enabled-state preservation
// ---------------------------------------------------------------------------

test('update: bumps a pinned local plugin\'s version + preserves enabled state', () => {
  const home = mkTmp('br-home-');
  const src = mkTmp('br-src-');
  const ws = mkTmp('br-ws-');
  const prevHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const srcRoot = path.join(src, 'upd-pinned');
    writePlugin(srcRoot, 'upd-pinned', '1.0.0');

    // Install v1.0.0 (user scope) + enable it.
    const inst = installPlugin(srcRoot, { scope: 'user', workspaceRoot: ws });
    assert.ok(inst.ok);
    setPluginEnabled('upd-pinned', true);
    assert.equal(isPluginEnabled(loadOrInitConfig(), 'upd-pinned'), true);

    // Bump the SOURCE to v2.0.0, then update.
    fs.writeFileSync(
      path.join(srcRoot, '.brainrouter-plugin', 'plugin.json'),
      JSON.stringify({ name: 'upd-pinned', version: '2.0.0', category: 'development' }),
    );
    const upd = updatePlugin('upd-pinned', { scope: 'user', workspaceRoot: ws });
    assert.ok(upd.ok);
    assert.equal(upd.updated, true);
    assert.equal(upd.fromVersion, '1.0.0');
    assert.equal(upd.toVersion, '2.0.0');

    // Installed copy is now v2.0.0.
    const installedManifest = JSON.parse(
      fs.readFileSync(path.join(userPluginsDir(), 'upd-pinned', '.brainrouter-plugin', 'plugin.json'), 'utf8'),
    );
    assert.equal(installedManifest.version, '2.0.0');

    // Enabled state survived the swap.
    assert.equal(isPluginEnabled(loadOrInitConfig(), 'upd-pinned'), true);
  } finally {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prevHome;
  }
});

test('update: same-version source reports "not updated"', () => {
  const home = mkTmp('br-home-');
  const src = mkTmp('br-src-');
  const ws = mkTmp('br-ws-');
  const prevHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const srcRoot = path.join(src, 'still-same');
    writePlugin(srcRoot, 'still-same', '1.0.0');
    assert.ok(installPlugin(srcRoot, { scope: 'user', workspaceRoot: ws }).ok);

    const upd = updatePlugin('still-same', { scope: 'user', workspaceRoot: ws });
    assert.ok(upd.ok);
    assert.equal(upd.updated, false);
  } finally {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prevHome;
  }
});

test('update: an uninstalled name errors', () => {
  const home = mkTmp('br-home-');
  const ws = mkTmp('br-ws-');
  const prevHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const results = updatePlugins({ name: 'nope', workspaceRoot: ws });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
  } finally {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prevHome;
  }
});

// ---------------------------------------------------------------------------
// auto-update check — surface (never install)
// ---------------------------------------------------------------------------

test('isNewerVersion: dotted semver comparison', () => {
  assert.equal(isNewerVersion('1.0.0', '1.0.1'), true);
  assert.equal(isNewerVersion('1.0.0', '2.0.0'), true);
  assert.equal(isNewerVersion('2.0.0', '1.9.9'), false);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion(undefined, '1.0.0'), true);
  assert.equal(isNewerVersion('1.0.0', undefined), false);
});

test('auto-update: computeAvailableUpdates surfaces a newer registry version', () => {
  const home = mkTmp('br-home-');
  const src = mkTmp('br-src-');
  const ws = mkTmp('br-ws-');
  const prevHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const srcRoot = path.join(src, 'acme-devkit');
    writePlugin(srcRoot, 'acme-devkit', '1.0.0');
    assert.ok(installPlugin(srcRoot, { scope: 'user', workspaceRoot: ws }).ok);

    const installed = listInstalledPlugins(ws);
    assert.equal(installed.length, 1);

    const index: RegistryIndex = {
      plugins: [
        { id: 'acme-devkit', name: 'acme-devkit', repo: '', version: '1.5.0', tags: [], stars: 0, provides: {} },
        { id: 'other', name: 'other', repo: '', version: '9.0.0', tags: [], stars: 0, provides: {} },
      ],
    };
    const updates = computeAvailableUpdates(installed, index);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].name, 'acme-devkit');
    assert.equal(updates[0].installedVersion, '1.0.0');
    assert.equal(updates[0].registryVersion, '1.5.0');

    // A same-or-older registry version surfaces nothing.
    const stale: RegistryIndex = { plugins: [{ id: 'acme-devkit', name: 'acme-devkit', repo: '', version: '1.0.0', tags: [], stars: 0, provides: {} }] };
    assert.equal(computeAvailableUpdates(installed, stale).length, 0);
  } finally {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prevHome;
  }
});

test('auto-update: runAutoUpdateCheck reads a LOCAL registry file + never installs', async () => {
  const home = mkTmp('br-home-');
  const src = mkTmp('br-src-');
  const ws = mkTmp('br-ws-');
  const prevHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const srcRoot = path.join(src, 'acme-devkit');
    writePlugin(srcRoot, 'acme-devkit', '1.0.0');
    assert.ok(installPlugin(srcRoot, { scope: 'user', workspaceRoot: ws }).ok);

    // Registry as a local file (fetchRegistry treats non-http as a file path).
    const regFile = path.join(home, 'registry.json');
    fs.writeFileSync(regFile, JSON.stringify({
      plugins: [{ id: 'acme-devkit', name: 'acme-devkit', repo: '', version: '3.0.0', tags: [], stars: 0, provides: {} }],
    }));

    // Gate OFF → does not run.
    const off = await runAutoUpdateCheck({ enabled: false, workspaceRoot: ws, registryUrl: regFile });
    assert.equal(off.ran, false);
    assert.equal(off.updates.length, 0);

    // Gate ON → surfaces the update but installs nothing.
    const on = await runAutoUpdateCheck({ enabled: true, workspaceRoot: ws, registryUrl: regFile });
    assert.equal(on.ran, true);
    assert.equal(on.updates.length, 1);
    assert.match(on.notice, /update.*available/i);
    assert.match(on.notice, /acme-devkit/);

    // The installed copy is untouched (still 1.0.0 — no install happened).
    const stillOne = JSON.parse(
      fs.readFileSync(path.join(userPluginsDir(), 'acme-devkit', '.brainrouter-plugin', 'plugin.json'), 'utf8'),
    );
    assert.equal(stillOne.version, '1.0.0');
  } finally {
    if (prevHome === undefined) delete process.env.BRAINROUTER_HOME; else process.env.BRAINROUTER_HOME = prevHome;
  }
});

test('formatUpdateNotice: empty when nothing available', () => {
  assert.equal(formatUpdateNotice([]), '');
});

// ---------------------------------------------------------------------------
// per-plugin .local.md config
// ---------------------------------------------------------------------------

test('local config: parses frontmatter + body from <name>.local.md', () => {
  const ws = mkTmp('br-ws-');
  const dir = workspacePluginsDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    pluginLocalConfigPath('acme-devkit', ws),
    [
      '---',
      'apiBase: https://api.example.com',
      'maxRetries: 3',
      'verbose: true',
      'tags:',
      '  - alpha',
      '  - beta',
      'nested:',
      '  key: val',
      '---',
      '',
      '# Project notes',
      'Use the staging key here.',
    ].join('\n'),
  );

  const cfg = readPluginLocalConfig('acme-devkit', ws);
  assert.equal(cfg.exists, true);
  assert.equal(cfg.config.apiBase, 'https://api.example.com');
  assert.equal(cfg.config.maxRetries, 3);
  assert.equal(cfg.config.verbose, true);
  assert.deepEqual(cfg.config.tags, ['alpha', 'beta']);
  assert.deepEqual(cfg.config.nested, { key: 'val' });
  assert.match(cfg.body, /Project notes/);
  assert.match(cfg.body, /staging key/);
});

test('local config: absent file yields a well-formed empty result', () => {
  const ws = mkTmp('br-ws-');
  const cfg = readPluginLocalConfig('nope', ws);
  assert.equal(cfg.exists, false);
  assert.deepEqual(cfg.config, {});
  assert.equal(cfg.body, '');
});
