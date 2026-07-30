/**
 * PLUGIN-MARKETPLACE P2 — marketplace tests.
 *
 * Covers: marketplace-manifest validation, config record helpers
 * (add/remove/list/update in `cli.plugins.marketplaces[]`), and — the headline —
 * a LOCAL marketplace fixture (a dir with `brainrouter-marketplace.json` + a
 * bundled plugin) whose plugin installs BY NAME; a failing install-by-name
 * leaves a prior version intact (P1 atomic staging); update reflects state.
 *
 * All state is confined to a temp `BRAINROUTER_HOME`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateMarketplaceManifest,
  parseMarketplaceManifest,
  classifyMarketplaceSource,
  addMarketplaceIn,
  removeMarketplaceIn,
  updateMarketplaceIn,
  fetchMarketplace,
  readMarketplaceManifestAt,
  resolvePluginByName,
  resolvePluginInstallSpec,
  installPluginByName,
  userPluginsDir,
} from './index.js';
import { resolveCliKnobs } from '../config/config.js';
import type { Config, MarketplaceSource } from '../config/configTypes.js';

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const baseCfg = (marketplaces: MarketplaceSource[] = [], plugins: Record<string, unknown> = {}): Config =>
  ({ activeServer: '', servers: {}, cli: { plugins: { marketplaces, ...plugins } } } as Config);

/** Write a plugin folder at <dir>/<rel> with a given name + version. */
function writePlugin(root: string, name: string, version = '1.0.0', manifestName = 'plugin.json'): void {
  const w = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  w(path.join('.brainrouter-plugin', manifestName), JSON.stringify({ name, version, category: 'development' }));
  w('skills/demo/SKILL.md', `---\nname: ${name}-demo\ndescription: demo\n---\n# demo\n`);
}

/**
 * Build a LOCAL marketplace fixture directory: a `brainrouter-marketplace.json`
 * at the root indexing one bundled plugin under `./plugins/<name>`.
 */
function writeLocalMarketplace(dir: string, marketName: string, pluginName: string, pluginVersion = '1.0.0'): void {
  writePlugin(path.join(dir, 'plugins', pluginName), pluginName, pluginVersion);
  fs.writeFileSync(
    path.join(dir, 'brainrouter-marketplace.json'),
    JSON.stringify({
      name: marketName,
      owner: { name: 'tester' },
      plugins: [
        { name: pluginName, description: 'demo', source: `./plugins/${pluginName}`, version: pluginVersion, category: 'development' },
      ],
    }),
  );
}

function writeAlternateMarketplace(dir: string, marketName: string, pluginName: string, manifestName: string): void {
  writePlugin(path.join(dir, 'plugins', pluginName), pluginName, '1.0.0', manifestName);
  fs.writeFileSync(
    path.join(dir, manifestName),
    JSON.stringify({
      name: marketName,
      plugins: [
        { name: pluginName, description: 'demo', source: `./plugins/${pluginName}`, version: '1.0.0', category: 'development' },
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

test('validateMarketplaceManifest: accepts a valid manifest', () => {
  const r = validateMarketplaceManifest({
    name: 'acme-market',
    owner: 'acme',
    plugins: [{ name: 'acme-devkit', source: './plugins/acme-devkit', version: '1.0.0' }],
  });
  assert.equal(r.valid, true);
  assert.equal(r.manifest?.name, 'acme-market');
  assert.equal(r.manifest?.plugins.length, 1);
  assert.equal(r.manifest?.plugins[0].name, 'acme-devkit');
});

test('validateMarketplaceManifest: requires name + plugins array', () => {
  assert.equal(validateMarketplaceManifest({ plugins: [] }).valid, false);
  assert.equal(validateMarketplaceManifest({ name: 'm' }).valid, false);
});

test('validateMarketplaceManifest: skips malformed plugin entries with a warning', () => {
  const r = validateMarketplaceManifest({
    name: 'm',
    plugins: [
      { name: 'good', source: './x' },
      { name: 'no-source' },
      { source: './y' },
      { name: 'good', source: './dup' },
    ],
  });
  assert.equal(r.valid, true);
  assert.equal(r.manifest?.plugins.length, 1);
  assert.ok(r.warnings.length >= 2);
});

test('parseMarketplaceManifest: reports a JSON syntax error', () => {
  const r = parseMarketplaceManifest('{ nope');
  assert.equal(r.valid, false);
  assert.ok(r.errors[0].includes('invalid JSON'));
});

test('classifyMarketplaceSource: distinguishes git / local / http', () => {
  assert.equal(classifyMarketplaceSource('./local/market'), 'local');
  assert.equal(classifyMarketplaceSource('git+https://github.com/u/r.git#v1'), 'git');
  assert.equal(classifyMarketplaceSource('https://github.com/u/r.git'), 'git');
  assert.equal(classifyMarketplaceSource('https://cdn.example.com/market.tgz'), 'http');
});

// ---------------------------------------------------------------------------
// Config record helpers
// ---------------------------------------------------------------------------

test('addMarketplaceIn / removeMarketplaceIn: record + deregister a source', () => {
  const cfg = baseCfg();
  const added = addMarketplaceIn(cfg, 'acme', '/some/dir');
  assert.equal(added.ok, true);
  assert.equal(added.entry?.sourceType, 'local');
  const list = added.config!.cli!.plugins!.marketplaces!;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'acme');

  // Duplicate without force refuses.
  const dup = addMarketplaceIn(added.config!, 'acme', '/other');
  assert.equal(dup.ok, false);

  // Force replaces.
  const forced = addMarketplaceIn(added.config!, 'acme', '/other', { force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.config!.cli!.plugins!.marketplaces!.length, 1);
  assert.equal(forced.config!.cli!.plugins!.marketplaces![0].source, '/other');

  // Remove.
  const removed = removeMarketplaceIn(forced.config!, 'acme');
  assert.equal(removed.ok, true);
  assert.equal(removed.config!.cli!.plugins!.marketplaces!.length, 0);
  assert.equal(removeMarketplaceIn(removed.config!, 'acme').ok, false);
});

test('addMarketplaceIn: rejects an invalid name / empty source', () => {
  assert.equal(addMarketplaceIn(baseCfg(), '', '/x').ok, false);
  assert.equal(addMarketplaceIn(baseCfg(), 'ok', '').ok, false);
});

// ---------------------------------------------------------------------------
// Fetch + resolve + install-by-name — LOCAL marketplace fixture
// ---------------------------------------------------------------------------

test('fetchMarketplace + readMarketplaceManifestAt: reads a local marketplace', (t) => {
  const market = mkTmp('br-market-');
  t.after(() => fs.rmSync(market, { recursive: true, force: true }));
  writeLocalMarketplace(market, 'acme-market', 'acme-devkit');

  const entry: MarketplaceSource = { name: 'acme-market', sourceType: 'local', source: market };
  const fetched = fetchMarketplace(entry);
  assert.equal(fetched.ok, true);
  if (!fetched.ok) return;
  const parsed = readMarketplaceManifestAt(fetched.fetched.dir);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.manifest?.plugins[0].name, 'acme-devkit');
});

test('MC-E3 alternate manifest names are accepted for marketplace and plugin imports only when configured', (t) => {
  const home = mkTmp('br-plug-home-');
  const market = mkTmp('br-market-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(market, { recursive: true, force: true });
  });

  const manifestName = 'external-manifest.json';
  writeAlternateMarketplace(market, 'acme-market', 'acme-devkit', manifestName);

  assert.equal(readMarketplaceManifestAt(market).valid, false);
  const parsed = readMarketplaceManifestAt(market, [manifestName]);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.manifest?.plugins[0].name, 'acme-devkit');

  const cfg = baseCfg([{ name: 'acme-market', sourceType: 'local', source: market }], { altManifestNames: [manifestName] });
  const resolved = resolvePluginByName('acme-devkit', cfg);
  assert.equal(resolved.ok, true);
  if (resolved.ok) resolved.resolved.fetched.cleanup?.();

  const installed = installPluginByName('acme-devkit', { scope: 'user', config: cfg });
  assert.equal(installed.ok, true);
  const installedTo = installed.result?.ok ? installed.result.installedTo : '';
  assert.ok(fs.existsSync(path.join(installedTo, '.brainrouter-plugin', manifestName)));
  assert.equal(fs.existsSync(path.join(installedTo, '.brainrouter-plugin', 'plugin.json')), false);
});

test('MC-E3 resolveCliKnobs keeps alternate manifest imports opt-in and filename-only', () => {
  const knobs = resolveCliKnobs(baseCfg([], {
    altManifestNames: [' external-manifest.json ', '../escape.json', 'nested/file.json', 'plugin.json', 'notes.txt', 'external-manifest.json'],
  }));
  assert.deepEqual(knobs.plugins.altManifestNames, ['external-manifest.json']);
  assert.deepEqual(resolveCliKnobs(baseCfg()).plugins.altManifestNames, []);
});

test('resolvePluginByName + resolvePluginInstallSpec: resolves a bundled plugin to a local source', (t) => {
  const market = mkTmp('br-market-');
  t.after(() => fs.rmSync(market, { recursive: true, force: true }));
  writeLocalMarketplace(market, 'acme-market', 'acme-devkit');
  const cfg = baseCfg([{ name: 'acme-market', sourceType: 'local', source: market }]);

  const r = resolvePluginByName('acme-devkit', cfg);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.resolved.marketplace, 'acme-market');
  const spec = resolvePluginInstallSpec(r.resolved);
  assert.equal(spec.ok, true);
  if (!spec.ok) return;
  assert.ok(spec.source.endsWith(path.join('plugins', 'acme-devkit')));
  assert.equal(spec.opts.marketplace, 'acme-market');
  r.resolved.fetched.cleanup?.();
});

test('resolvePluginByName: unknown plugin / no marketplaces → error', () => {
  assert.equal(resolvePluginByName('nope', baseCfg()).ok, false);
  const market = baseCfg([{ name: 'm', sourceType: 'local', source: '/does/not/exist' }]);
  assert.equal(resolvePluginByName('nope', market).ok, false);
});

test('installPluginByName: installs a bundled plugin from a LOCAL marketplace', (t) => {
  const home = mkTmp('br-plug-home-');
  const market = mkTmp('br-market-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(market, { recursive: true, force: true });
  });

  writeLocalMarketplace(market, 'acme-market', 'acme-devkit', '1.0.0');
  const cfg = baseCfg([{ name: 'acme-market', sourceType: 'local', source: market }]);

  const r = installPluginByName('acme-devkit', { scope: 'user', config: cfg });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.marketplace, 'acme-market');
  const installedTo = r.result!.ok ? r.result!.installedTo : '';
  assert.ok(fs.existsSync(path.join(installedTo, '.brainrouter-plugin', 'plugin.json')));

  // install.json records the marketplace provenance.
  const rec = JSON.parse(fs.readFileSync(path.join(installedTo, 'install.json'), 'utf8'));
  assert.equal(rec.marketplace, 'acme-market');
  assert.equal(rec.sourceType, 'local');

  // No leftover staging.
  const staging = path.join(userPluginsDir(), '.staging');
  const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  assert.deepEqual(leftovers, []);
});

test('installPluginByName: a failing install leaves the prior version intact (atomic)', (t) => {
  const home = mkTmp('br-plug-home-');
  const market = mkTmp('br-market-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(market, { recursive: true, force: true });
  });

  // Install a good v1 by name.
  writeLocalMarketplace(market, 'acme-market', 'acme-devkit', '1.0.0');
  const cfg = baseCfg([{ name: 'acme-market', sourceType: 'local', source: market }]);
  const first = installPluginByName('acme-devkit', { scope: 'user', config: cfg });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const installedTo = first.result!.ok ? first.result!.installedTo : '';
  const liveManifest = path.join(installedTo, '.brainrouter-plugin', 'plugin.json');
  const v1 = fs.readFileSync(liveManifest, 'utf8');
  assert.equal(JSON.parse(v1).version, '1.0.0');

  // Now corrupt the marketplace's plugin so re-installing (force) fails validation.
  fs.writeFileSync(
    path.join(market, 'plugins', 'acme-devkit', '.brainrouter-plugin', 'plugin.json'),
    '{ "name": "Not Kebab" }',
  );
  const second = installPluginByName('acme-devkit', { scope: 'user', force: true, config: cfg });
  assert.equal(second.ok, false);

  // The live v1 copy is untouched.
  assert.equal(fs.readFileSync(liveManifest, 'utf8'), v1);
  const staging = path.join(userPluginsDir(), '.staging');
  const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  assert.deepEqual(leftovers, []);
});

test('updateMarketplaceIn: re-reads a local marketplace + records lastUpdated', (t) => {
  const market = mkTmp('br-market-');
  t.after(() => fs.rmSync(market, { recursive: true, force: true }));
  writeLocalMarketplace(market, 'acme-market', 'acme-devkit');
  const cfg = baseCfg([{ name: 'acme-market', sourceType: 'local', source: market }]);

  const r = updateMarketplaceIn(cfg, 'acme-market');
  assert.equal(r.ok, true);
  assert.equal(r.plugins, 1);
  const updated = r.config!.cli!.plugins!.marketplaces![0];
  assert.ok(updated.lastUpdated);

  // Unknown marketplace → error.
  assert.equal(updateMarketplaceIn(cfg, 'nope').ok, false);
});
