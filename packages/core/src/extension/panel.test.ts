/**
 * EXTENSION-PANEL tests — an extension that declares `contributes: ['panels']`
 * and calls `host.registerPanel(...)` in its `activate()` becomes discoverable
 * through the module-level registry accessors, and a throwing panel activate is
 * fault-isolated like every other contribution.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Per-user trust + enable state under a throwaway home (mirrors extension-loader test).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'br-extpanel-home-'));
process.env.BRAINROUTER_HOME = TMP_HOME;

const { loadExtensions } = await import('./loader.js');
const { extensionPanels, extensionPanel, extensionContributionSummary } = await import('./registry.js');
const { createExtensionHost } = await import('./host.js');
const { trustWorkspace } = await import('../workspace/workspaceTrust.js');

/** Create a workspace-tier extension whose index.js body is `body`. */
function mkWorkspaceExt(name: string, body: string, contributes?: string[]): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'br-extpanel-ws-'));
  const dir = path.join(ws, '.brainrouter', 'extensions', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'extension.json'),
    JSON.stringify({ name, version: '1.0.0', contributes: contributes ?? [] }),
    'utf-8',
  );
  fs.writeFileSync(path.join(dir, 'index.js'), body, 'utf-8');
  return ws;
}

// A panels-contributing extension: componentKey view spec.
const PANEL_EXT = `export const activate = (host) => {
  host.registerPanel({ id: 'demo_panel', title: 'Demo Panel', icon: '🧩', componentKey: 'demo.view' });
};`;

test('a panels-contributing extension registers a discoverable descriptor', async () => {
  const ws = mkWorkspaceExt('w-panel', PANEL_EXT, ['panels']);
  trustWorkspace(ws);

  const r = await loadExtensions(ws);
  assert.ok(r.activated.includes('w-panel'), 'w-panel activated');

  const panel = extensionPanel('demo_panel');
  assert.ok(panel, 'panel is discoverable by id via the accessor');
  assert.equal(panel?.title, 'Demo Panel');
  assert.equal(panel?.icon, '🧩');
  assert.equal(panel?.componentKey, 'demo.view');

  assert.ok(extensionPanels().some((p) => p.id === 'demo_panel'), 'panel appears in the full list');
  assert.ok(
    extensionContributionSummary().panels.some((s) => s.startsWith('demo_panel')),
    'panel appears in the contribution summary',
  );
});

test('loadExtensions resets panels between runs (idempotent reload)', async () => {
  // Loading a workspace with no panel-contributing extension must clear the prior panel.
  const empty = mkWorkspaceExt('w-nopanel', `export const activate = () => {};`);
  trustWorkspace(empty);
  await loadExtensions(empty);
  assert.equal(extensionPanel('demo_panel'), undefined, 'prior panel dropped on reload');
});

test('a throwing panel activate is fault-isolated, not fatal', async () => {
  const ws = mkWorkspaceExt(
    'w-panel-throw',
    `export const activate = (host) => {
       host.registerPanel({ id: 'ok_panel', title: 'OK', componentKey: 'ok.view' });
       throw new Error('panel-boom');
     };`,
    ['panels'],
  );
  trustWorkspace(ws);
  const r = await loadExtensions(ws);
  assert.ok(!r.activated.includes('w-panel-throw'), 'throwing extension not marked activated');
  const e = r.errors.find((x) => x.name === 'w-panel-throw');
  assert.ok(e && /panel-boom/.test(e.error), 'error recorded, host survives');
});

test('registerPanel via a direct host: last registration for an id wins', () => {
  const host = createExtensionHost('unit-ext', '/tmp/ws', '1.0.0');
  host.registerPanel({ id: 'dup', title: 'First', componentKey: 'a' });
  host.registerPanel({ id: 'dup', title: 'Second', url: 'https://example.test/panel' });
  const panel = extensionPanel('dup');
  assert.equal(panel?.title, 'Second', 'later registration shadows the earlier one');
  assert.equal(panel?.url, 'https://example.test/panel');
  assert.equal(panel?.componentKey, undefined);
  // Exactly one entry for the id.
  assert.equal(extensionPanels().filter((p) => p.id === 'dup').length, 1);
});
