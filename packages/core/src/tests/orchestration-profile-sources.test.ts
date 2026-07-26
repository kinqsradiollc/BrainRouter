import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findResolvedOrchestrationProfile,
  resolveOrchestrationProfileSources,
} from '../orchestration/profiles/orchestrationProfileSources.js';
import {
  bundledOrchestrationProfileReferences,
} from '../orchestration/profiles/orchestrationProfileCatalog.js';
import { loadPlugins } from '../plugin/loader.js';
import type { Config } from '../config/configTypes.js';

function workspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-plan-sources-')));
}

function directProfile(id: string, skillIds: string[] = []): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'orchestration-profile',
    id,
    displayName: `${id} orchestration`,
    defaultMode: 'off',
    fallbackStrategyId: 'direct',
    rolePolicy: { availableRoles: [], disabledRoles: [] },
    limits: {
      maxParallel: 1,
      maxStages: 1,
      maxChildrenPerStage: 1,
      maxTotalChildren: 1,
      maxDepth: 1,
      maxRetries: 0,
    },
    strategies: [{
      id: 'direct',
      description: 'Complete on the primary agent.',
      activation: { signals: [], explicitOnly: false },
      stages: [{
        id: 'complete',
        executor: { kind: 'primary' },
        after: [],
        objective: 'Complete the reviewed task directly.',
        skillIds,
        optional: false,
      }],
    }],
  });
}

function write(root: string, relative: string, contents: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

test('workspace-local wins whole-definition collisions across every lower source', (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '.brainrouter/orchestration-profiles/custom.json', directProfile('custom'));
  write(root, 'orchestration-profiles/custom.json', directProfile('custom'));
  const pluginFile = write(root, 'plugin/orchestration-profiles/custom.json', directProfile('custom'));

  const catalog = resolveOrchestrationProfileSources({
    workspaceRoot: root,
    pluginContributions: {
      orchestrationProfileFiles: [{ pluginName: 'fixture-plugin', path: pluginFile }],
    },
  });
  const resolved = findResolvedOrchestrationProfile(catalog, 'custom');
  assert.equal(resolved?.source.kind, 'workspace-local');
  assert.equal(catalog.diagnostics.filter((item) =>
    item.code === 'collision' && item.id === 'custom').length, 3);
  assert.equal(catalog.diagnostics.some((item) =>
    item.message.includes(root)), false);
});

test('invalid higher-precedence references block bundled fallback for the same id', (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(
    root,
    '.brainrouter/orchestration-profiles/research.json',
    directProfile('research', ['missing-skill']),
  );

  const catalog = resolveOrchestrationProfileSources({ workspaceRoot: root });
  assert.equal(findResolvedOrchestrationProfile(catalog, 'research'), undefined);
  assert.equal(catalog.unavailableIds.has('research'), true);
  assert.equal(catalog.diagnostics.some((item) =>
    item.code === 'unavailable-reference' && item.id === 'research'), true);
  assert.equal(catalog.diagnostics.some((item) =>
    item.code === 'collision'
    && item.id === 'research'
    && item.source.kind === 'bundled'), true);
});

test('only enabled plugin loader output participates in plugin precedence', (t) => {
  const root = workspace();
  const home = workspace();
  const priorHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = priorHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const pluginRoot = path.join(home, 'plugins', 'fixture-plugin');
  write(pluginRoot, '.brainrouter-plugin/plugin.json', JSON.stringify({ name: 'fixture-plugin' }));
  write(pluginRoot, 'orchestration-profiles/custom.json', directProfile('custom'));

  const config = (enabled: boolean): Config => ({
    activeServer: '',
    servers: {},
    cli: { plugins: { enabled: { 'fixture-plugin': enabled } } },
  } as Config);
  const disabled = loadPlugins(root, config(false));
  const disabledCatalog = resolveOrchestrationProfileSources({
    workspaceRoot: root,
    pluginContributions: disabled.contributions,
  });
  assert.equal(findResolvedOrchestrationProfile(disabledCatalog, 'custom')?.source.kind, 'bundled');

  const enabled = loadPlugins(root, config(true));
  const enabledCatalog = resolveOrchestrationProfileSources({
    workspaceRoot: root,
    pluginContributions: enabled.contributions,
  });
  assert.equal(findResolvedOrchestrationProfile(enabledCatalog, 'custom')?.source.provenance, 'plugin:fixture-plugin');
});

test('symlinked workspace source is ignored without escaping containment', (t) => {
  const root = workspace();
  const outside = workspace();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  write(outside, 'custom.json', directProfile('custom'));
  fs.mkdirSync(path.join(root, '.brainrouter'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, '.brainrouter', 'orchestration-profiles'));

  const catalog = resolveOrchestrationProfileSources({
    workspaceRoot: root,
    references: bundledOrchestrationProfileReferences(),
  });
  assert.equal(findResolvedOrchestrationProfile(catalog, 'custom')?.source.kind, 'bundled');
});
