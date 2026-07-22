import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeProvides } from '../plugin/discovery.js';
import {
  findWorkspaceProfilePlugin,
  inspectWorkspaceProfilePlugins,
  WORKSPACE_PROFILE_PLUGIN_DEFINITIONS,
} from '../workspace/profilePlugins.js';

test('C2 package-owned profile plugins use the standard versioned plugin contract', () => {
  const catalog = inspectWorkspaceProfilePlugins();

  assert.deepEqual(catalog.unavailable, []);
  assert.deepEqual(
    catalog.available.map((plugin) => plugin.id),
    ['study', 'research', 'data', 'writing', 'frontend'],
  );
  for (const plugin of catalog.available) {
    assert.equal(plugin.version, '1.0.0');
    assert.equal(plugin.plugin.manifest.version, plugin.version);
    assert.equal(plugin.plugin.manifest.name, plugin.pluginName);
    assert.equal(summarizeProvides(plugin.plugin).skills, plugin.skillIds.length);
  }
});

test('C2 every declared profile skill is discoverable and machine-addressable', () => {
  const catalog = inspectWorkspaceProfilePlugins();

  for (const plugin of catalog.available) {
    for (const skillId of plugin.skillIds) {
      const skillFile = path.join(plugin.skillsRoot, skillId, 'SKILL.md');
      const body = fs.readFileSync(skillFile, 'utf8');
      assert.match(body, new RegExp(`^---\\nname: ${skillId}\\n`, 'm'));
      assert.match(body, /^description: .+$/m);
      assert.match(body, /^## Overview$/m);
      assert.match(body, /^## When to Use$/m);
      assert.match(body, /^## Workflow$/m);
      assert.match(body, /^## Verification$/m);
    }
  }
});

test('C2 frontend stays a capability plugin and owns the design verification skills', () => {
  const frontend = findWorkspaceProfilePlugin('frontend');

  assert.ok(frontend);
  assert.equal(frontend.kind, 'capability');
  assert.equal(frontend.pluginName, 'capability-frontend');
  assert.deepEqual(frontend.skillIds, ['a11y-skill', 'browser-testing-skill', 'taste-skill']);
  assert.equal(WORKSPACE_PROFILE_PLUGIN_DEFINITIONS.some((plugin) => plugin.pluginName.includes('builder')), false);
});

test('C2 missing package artifacts are reported as unavailable instead of throwing', (t) => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-plugins-'));
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));

  const catalog = inspectWorkspaceProfilePlugins({ root: emptyRoot });
  assert.equal(catalog.available.length, 0);
  assert.equal(catalog.unavailable.length, WORKSPACE_PROFILE_PLUGIN_DEFINITIONS.length);
  assert.equal(findWorkspaceProfilePlugin('frontend', { root: emptyRoot }), undefined);
});

test('C2 malformed package-owned versions fail availability without affecting sibling plugins', (t) => {
  const source = path.dirname(inspectWorkspaceProfilePlugins().available[0].root);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-plugin-version-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.cpSync(source, fixtureRoot, { recursive: true });
  const manifestPath = path.join(fixtureRoot, 'frontend', '.brainrouter-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: 'draft' }, null, 2)}\n`);

  const catalog = inspectWorkspaceProfilePlugins({ root: fixtureRoot });
  assert.deepEqual(catalog.available.map((plugin) => plugin.id), ['study', 'research', 'data', 'writing']);
  assert.equal(catalog.unavailable[0]?.id, 'frontend');
  assert.match(catalog.unavailable[0]?.reason ?? '', /semantic/);
});

test('C2 the published core package declares its profile plugin assets', () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { files?: string[] };
  assert.ok(packageJson.files?.includes('profile-plugins'));
});
