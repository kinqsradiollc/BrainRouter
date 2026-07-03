/**
 * PLUGIN-MARKETPLACE P3 — registry / integrity / consent / managed-gating tests.
 *
 * Covers the P3 gate list:
 *   - search returns ranked results from a fixture registry.json (relevance→stars)
 *   - integrity mismatch aborts install (atomic — prior version intact)
 *   - consent summary enumerates capabilities (skills/hooks[with cmd]/MCP[with cmd])
 *   - a blockedMarketplace is refused (add + resolve)
 *   - allowManagedHooksOnly disables a plugin's hooks
 *   - an incompatible compatibility.brainrouterVersion warns
 *
 * All disk state is confined to a temp `BRAINROUTER_HOME`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  // registry
  validateRegistryIndex,
  parseRegistryIndex,
  searchRegistry,
  fetchRegistry,
  fetchAndSearch,
  clearRegistryCache,
  resolveRegistryUrl,
  DEFAULT_REGISTRY_URL,
  // integrity
  sha256Integrity,
  verifyIntegrity,
  hashDirectory,
  compareDigest,
  // trust / consent / gating
  buildConsentSummary,
  checkCompatibility,
  parseVersionExpr,
  assertMarketplaceAllowed,
  hooksAllowed,
  commandHooksEnabled,
  mcpServersEnabled,
  // loader + install + marketplace + service
  discoverPlugin,
  installPlugin,
  loadPluginsWithKnobs,
  setPluginConsentIn,
  addMarketplaceIn,
  resolvePluginByName,
  userPluginsDir,
} from './index.js';
import type { Config } from '../config/configTypes.js';

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Write a plugin folder with a shell hook + an MCP command-server so it has risky caps. */
function writeRiskyPlugin(root: string, name: string, extra: Record<string, unknown> = {}): void {
  const w = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  w('.brainrouter-plugin/plugin.json', JSON.stringify({ name, version: '1.0.0', category: 'development', ...extra }));
  w('skills/demo/SKILL.md', `---\nname: ${name}-demo\ndescription: demo\n---\n# demo\n`);
  w('hooks/hooks.json', JSON.stringify({ PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '${BRAINROUTER_PLUGIN_ROOT}/scripts/guard.sh' }] }] }));
  w('mcp.json', JSON.stringify({ mcpServers: { srv: { command: 'node', args: ['${BRAINROUTER_PLUGIN_ROOT}/server.js'] } } }));
}

const REGISTRY_FIXTURE = {
  plugins: [
    { id: 'acme-devkit', name: 'acme-devkit', repo: 'git+https://github.com/acme/devkit.git', version: '1.2.0', category: 'development', tags: ['ci', 'lint'], stars: 40, integrity: 'sha256-abc', author: 'acme', description: 'A development toolkit', provides: { skills: 3, hooks: 2, mcpServers: 1 } },
    { id: 'devtools-lite', name: 'devtools-lite', repo: 'git+https://github.com/x/lite.git', version: '0.1.0', category: 'development', tags: ['lint'], stars: 200, provides: { skills: 1 } },
    { id: 'research-buddy', name: 'research-buddy', repo: 'git+https://github.com/x/rb.git', category: 'research', tags: ['papers'], stars: 5, provides: { agents: 1 } },
  ],
};

// ---------------------------------------------------------------------------
// registry.json parse + search
// ---------------------------------------------------------------------------

test('validateRegistryIndex: parses entries, drops malformed ones', () => {
  const r = validateRegistryIndex({ plugins: [REGISTRY_FIXTURE.plugins[0], { nope: true }, { name: 'no-id-ok', repo: '', tags: [], stars: 0, provides: {} }] });
  assert.equal(r.valid, true);
  // entry 2 has no id/name → skipped; entry 3 (name only) is kept (id falls back to name)
  assert.equal(r.index!.plugins.length, 2);
  assert.equal(r.index!.plugins[0].id, 'acme-devkit');
});

test('searchRegistry: ranks by relevance then stars, filters by category/tag', () => {
  const { index } = validateRegistryIndex(REGISTRY_FIXTURE);
  // Query "devkit": acme-devkit matches by name; devtools-lite does not.
  const hits = searchRegistry(index!, 'devkit');
  assert.equal(hits[0].entry.id, 'acme-devkit');
  assert.ok(hits.every((h) => h.entry.id !== 'research-buddy'));

  // Empty query → star sort. devtools-lite (200) outranks acme-devkit (40).
  const browse = searchRegistry(index!, '');
  assert.equal(browse[0].entry.id, 'devtools-lite');

  // Tag "lint" narrows to the two dev plugins; category "research" isolates the third.
  assert.equal(searchRegistry(index!, '', { tag: 'lint' }).length, 2);
  const research = searchRegistry(index!, '', { category: 'research' });
  assert.equal(research.length, 1);
  assert.equal(research[0].entry.id, 'research-buddy');
});

test('searchRegistry: relevance beats stars (name match outranks a higher-star tag match)', () => {
  const { index } = validateRegistryIndex(REGISTRY_FIXTURE);
  // "lint" is a tag on both; devtools-lite ALSO name-matches "lite"? no — query "acme".
  const hits = searchRegistry(index!, 'acme');
  assert.equal(hits[0].entry.id, 'acme-devkit'); // name hit, even though 40 < 200 stars
});

test('fetchRegistry + fetchAndSearch: reads a LOCAL registry file (path override), cached', async (t) => {
  clearRegistryCache();
  const dir = mkTmp('br-reg-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'registry.json');
  fs.writeFileSync(file, JSON.stringify(REGISTRY_FIXTURE));

  const first = await fetchRegistry(file);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.fromCache, false);
  assert.equal(first.index.plugins.length, 3);

  const second = await fetchRegistry(file);
  assert.ok(second.ok && second.fromCache === true);

  const searched = await fetchAndSearch(file, 'research');
  assert.ok(searched.ok && searched.hits[0].entry.id === 'research-buddy');
});

test('resolveRegistryUrl: falls back to the built-in default', () => {
  assert.equal(resolveRegistryUrl(''), DEFAULT_REGISTRY_URL);
  assert.equal(resolveRegistryUrl('  '), DEFAULT_REGISTRY_URL);
  assert.equal(resolveRegistryUrl('https://x/registry.json'), 'https://x/registry.json');
});

test('parseRegistryIndex: reports a JSON syntax error', () => {
  const r = parseRegistryIndex('{ oops');
  assert.equal(r.valid, false);
});

// ---------------------------------------------------------------------------
// integrity
// ---------------------------------------------------------------------------

test('verifyIntegrity: matches sha256-<base64> and bare hex, fails on mismatch', () => {
  const data = 'hello world';
  const good = sha256Integrity(data);
  assert.equal(verifyIntegrity(data, good).ok, true);
  assert.equal(verifyIntegrity(data, 'sha256-deadbeef').ok, false);
  // empty declared → pass (no pin)
  assert.equal(verifyIntegrity(data, '').ok, true);
  // malformed → fail closed
  assert.equal(verifyIntegrity(data, 'md5-xxx').ok, false);
});

test('hashDirectory + compareDigest: deterministic, excludes install.json', (t) => {
  const dir = mkTmp('br-hash-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'x.txt'), 'content');
  const h1 = hashDirectory(dir);
  // Adding install.json must NOT change the digest.
  fs.writeFileSync(path.join(dir, 'install.json'), JSON.stringify({ installedAt: 'now' }));
  const h2 = hashDirectory(dir);
  assert.equal(h1, h2);
  assert.equal(compareDigest(h1, h1).ok, true);
  assert.equal(compareDigest(h1, 'sha256-deadbeef').ok, false);
});

// ---------------------------------------------------------------------------
// integrity mismatch aborts install (atomic)
// ---------------------------------------------------------------------------

test('installPlugin: integrity mismatch ABORTS + leaves any prior version intact', (t) => {
  const home = mkTmp('br-int-home-');
  const src = mkTmp('br-int-src-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  });

  // Build a plugin source.
  writeRiskyPlugin(src, 'acme-devkit');

  // First install with the CORRECT integrity (compute it over the source tree).
  const good = hashDirectory(src);
  const first = installPlugin(src, { scope: 'user', integrity: good });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const liveManifest = path.join(first.installedTo, '.brainrouter-plugin', 'plugin.json');
  const v1 = fs.readFileSync(liveManifest, 'utf8');

  // Re-install with a BOGUS integrity → aborts, live copy untouched.
  const second = installPlugin(src, { scope: 'user', force: true, integrity: 'sha256-deadbeef' });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.match(second.error, /integrity/i);
  assert.equal(fs.readFileSync(liveManifest, 'utf8'), v1); // unchanged

  // No staging leftovers.
  const staging = path.join(userPluginsDir(), '.staging');
  const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  assert.deepEqual(leftovers, []);
});

// ---------------------------------------------------------------------------
// consent / disclosure summary
// ---------------------------------------------------------------------------

test('buildConsentSummary: enumerates capabilities + surfaces hook/MCP commands', (t) => {
  const src = mkTmp('br-consent-');
  t.after(() => fs.rmSync(src, { recursive: true, force: true }));
  writeRiskyPlugin(src, 'acme-devkit');
  const disc = discoverPlugin(src);
  assert.equal(disc.ok, true);
  if (!disc.ok) return;

  const summary = buildConsentSummary(disc.plugin, { runtime: { brainrouterVersion: '0.4.17' } });
  assert.equal(summary.name, 'acme-devkit');
  assert.equal(summary.provides.skills, 1);
  assert.equal(summary.provides.hooks >= 1, true);
  assert.equal(summary.provides.mcpServers, 1);
  assert.equal(summary.requiresConsent, true);
  assert.equal(summary.shellApproved, false);
  assert.equal(summary.mcpApproved, false);
  // Hook command surfaced with ${BRAINROUTER_PLUGIN_ROOT} expanded to the real root.
  assert.equal(summary.hookCommands.length >= 1, true);
  assert.ok(summary.hookCommands[0].command.includes(disc.plugin.root));
  assert.ok(summary.mcpCommands[0].command.includes('node'));
  // Disclosure mentions the counts + the risky commands.
  assert.match(summary.disclosure, /skill/);
  assert.match(summary.disclosure, /Hooks run/);

  // With consent recorded, the summary reflects approval.
  const approved = buildConsentSummary(disc.plugin, { approved: { shell: true, mcp: true }, runtime: { brainrouterVersion: '0.4.17' } });
  assert.equal(approved.shellApproved, true);
  assert.equal(approved.mcpApproved, true);
});

// ---------------------------------------------------------------------------
// compatibility warnings
// ---------------------------------------------------------------------------

test('parseVersionExpr: understands >= / <= / range / bare', () => {
  assert.deepEqual(parseVersionExpr('>=0.4.17'), { min: '0.4.17', ok: true });
  assert.deepEqual(parseVersionExpr('<2.0.0'), { max: '2.0.0', ok: true });
  assert.deepEqual(parseVersionExpr('0.4.0 - 0.5.0'), { min: '0.4.0', max: '0.5.0', ok: true });
  assert.equal(parseVersionExpr('garbage').ok, false);
});

test('checkCompatibility: warns when the running version is below the required minimum', () => {
  const manifest = { name: 'x', compatibility: { brainrouterVersion: '>=0.9.0', agentApiVersion: '2' } };
  const warnings = checkCompatibility(manifest, { brainrouterVersion: '0.4.17', agentApiVersion: '1' });
  assert.equal(warnings.length, 2); // version below min + agentApiVersion mismatch
  assert.match(warnings[0], /below the required minimum/);

  // Compatible → no warnings.
  const okManifest = { name: 'x', compatibility: { brainrouterVersion: '>=0.4.0', agentApiVersion: '1' } };
  assert.deepEqual(checkCompatibility(okManifest, { brainrouterVersion: '0.4.17', agentApiVersion: '1' }), []);
});

// ---------------------------------------------------------------------------
// managed gating — blocked / allowed marketplaces
// ---------------------------------------------------------------------------

test('assertMarketplaceAllowed: blocks a blocked marketplace, enforces a non-empty allowlist', () => {
  assert.equal(assertMarketplaceAllowed('acme', { allowedMarketplaces: [], blockedMarketplaces: ['acme'], allowManagedHooksOnly: false }) !== null, true);
  assert.equal(assertMarketplaceAllowed('acme', { allowedMarketplaces: ['other'], blockedMarketplaces: [], allowManagedHooksOnly: false }) !== null, true);
  assert.equal(assertMarketplaceAllowed('acme', { allowedMarketplaces: ['acme'], blockedMarketplaces: [], allowManagedHooksOnly: false }), null);
  assert.equal(assertMarketplaceAllowed('acme', { allowedMarketplaces: [], blockedMarketplaces: [], allowManagedHooksOnly: false }), null);
});

const cfgWithGates = (over: Partial<{ blockedMarketplaces: string[]; allowedMarketplaces: string[]; allowManagedHooksOnly: boolean; marketplaces: unknown[] }>): Config =>
  ({ activeServer: '', servers: {}, cli: { plugins: { blockedMarketplaces: [], allowedMarketplaces: [], allowManagedHooksOnly: false, marketplaces: [], ...over } } } as unknown as Config);

test('addMarketplaceIn: refuses a blocked marketplace', () => {
  const cfg = cfgWithGates({ blockedMarketplaces: ['evil'] });
  assert.equal(addMarketplaceIn(cfg, 'evil', '/some/dir').ok, false);
  assert.equal(addMarketplaceIn(cfg, 'fine', '/some/dir').ok, true);
});

test('resolvePluginByName: skips a blocked marketplace during resolution', () => {
  const cfg = cfgWithGates({
    blockedMarketplaces: ['evil'],
    marketplaces: [{ name: 'evil', sourceType: 'local', source: '/does/not/matter' }],
  });
  const r = resolvePluginByName('anything', cfg);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /blocked by managed policy/);
});

// ---------------------------------------------------------------------------
// allowManagedHooksOnly + per-plugin consent gate the loader
// ---------------------------------------------------------------------------

test('gating helpers: hooksAllowed / commandHooksEnabled / mcpServersEnabled', () => {
  assert.equal(hooksAllowed({ allowManagedHooksOnly: false }), true);
  assert.equal(hooksAllowed({ allowManagedHooksOnly: true }), false);
  assert.equal(commandHooksEnabled({ allowManagedHooksOnly: false }, { shell: true }), true);
  assert.equal(commandHooksEnabled({ allowManagedHooksOnly: false }, { shell: false }), false);
  assert.equal(commandHooksEnabled({ allowManagedHooksOnly: true }, { shell: true }), false);
  assert.equal(mcpServersEnabled({ mcp: true }), true);
  assert.equal(mcpServersEnabled(undefined), false);
});

test('loadPluginsWithKnobs: allowManagedHooksOnly disables plugin hooks; consent enables risky caps', (t) => {
  const home = mkTmp('br-load-home-');
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Install a risky plugin into the user scope.
  const src = mkTmp('br-load-src-');
  t.after(() => fs.rmSync(src, { recursive: true, force: true }));
  writeRiskyPlugin(src, 'acme-devkit');
  const inst = installPlugin(src, { scope: 'user' });
  assert.equal(inst.ok, true);

  const baseKnobs = (plugins: Record<string, unknown>) => ({
    safeMode: false,
    plugins: {
      enabled: { 'acme-devkit': true },
      registryUrl: '',
      marketplaces: [],
      approved: {},
      allowedMarketplaces: [],
      blockedMarketplaces: [],
      allowManagedHooksOnly: false,
      ...plugins,
    },
  });

  // 1) No consent → hooks + MCP gated out (not registered).
  const gated = loadPluginsWithKnobs(home /* workspaceRoot irrelevant; user scope */, baseKnobs({}) as never);
  // The plugin loads, but its hook + MCP contributions are withheld.
  assert.equal(gated.contributions.hookFiles.length, 0);
  assert.equal(gated.contributions.mcpConfigFiles.length, 0);
  assert.equal(gated.loaded[0]?.hooksGated, true);
  assert.equal(gated.loaded[0]?.mcpGated, true);

  // 2) With shell + mcp consent → both register.
  const consented = loadPluginsWithKnobs(home, baseKnobs({ approved: { 'acme-devkit': { shell: true, mcp: true } } }) as never);
  assert.equal(consented.contributions.hookFiles.length, 1);
  assert.equal(consented.contributions.mcpConfigFiles.length, 1);

  // 3) allowManagedHooksOnly refuses hooks even WITH shell consent.
  const managed = loadPluginsWithKnobs(home, baseKnobs({ approved: { 'acme-devkit': { shell: true, mcp: true } }, allowManagedHooksOnly: true }) as never);
  assert.equal(managed.contributions.hookFiles.length, 0);
  assert.equal(managed.contributions.mcpConfigFiles.length, 1); // MCP still allowed
  assert.ok(managed.warnings.some((w) => /allowManagedHooksOnly/.test(w)));
});

// ---------------------------------------------------------------------------
// consent config mutation
// ---------------------------------------------------------------------------

test('setPluginConsentIn: records + revokes shell/mcp, tidies empty entries', () => {
  const cfg = { activeServer: '', servers: {}, cli: { plugins: {} } } as unknown as Config;
  const granted = setPluginConsentIn(cfg, 'acme-devkit', { shell: true });
  assert.equal(granted.cli!.plugins!.approved!['acme-devkit'].shell, true);
  const both = setPluginConsentIn(granted, 'acme-devkit', { mcp: true });
  assert.equal(both.cli!.plugins!.approved!['acme-devkit'].mcp, true);
  // Revoke both → entry removed.
  const revoked = setPluginConsentIn(setPluginConsentIn(both, 'acme-devkit', { shell: false }), 'acme-devkit', { mcp: false });
  assert.equal(revoked.cli!.plugins!.approved!['acme-devkit'], undefined);
});
