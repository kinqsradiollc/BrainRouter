// ADR-041 A41-9 — universal disposables. Every ExtensionHost registrar returns a
// handle that removes EXACTLY its own contribution (by identity), and
// disposeExtensionHost unwinds a host's contributions in reverse (LIFO).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHost, disposeExtensionHost, type ExtensionToolDef } from '../extension/host.js';
import { extensionToolEntries, extensionPanels, resetExtensionContributions } from '../extension/registry.js';

const toolDef = (name: string): ExtensionToolDef => ({
  name,
  description: name,
  inputSchema: {},
  accessTier: 'read',
  actionKind: 'read_only',
  handle: () => 'ok',
});

test('A41-9 — a registrar returns a disposable that removes exactly its contribution', () => {
  resetExtensionContributions();
  const host = createExtensionHost('ext-a', '/tmp', '1');
  const d1 = host.registerTool(toolDef('t1'));
  host.registerTool(toolDef('t2'));
  assert.deepEqual(extensionToolEntries().map((e) => e.name).sort(), ['t1', 't2']);

  d1.dispose();
  assert.deepEqual(extensionToolEntries().map((e) => e.name), ['t2'], 'only t1 was removed');

  // Idempotent — disposing the same handle again is a no-op.
  d1.dispose();
  assert.deepEqual(extensionToolEntries().map((e) => e.name), ['t2']);
});

test('A41-9 — a stale handle never removes a newer same-name contribution (identity, not name)', () => {
  resetExtensionContributions();
  const host = createExtensionHost('ext-a', '/tmp', '1');
  const stale = host.registerTool(toolDef('x')); // v1
  host.registerTool(toolDef('x')); // v2 replaces v1 in the registry
  assert.deepEqual(extensionToolEntries().map((e) => e.name), ['x']);

  stale.dispose(); // v1's contribution was already spliced by the replace → no-op
  assert.deepEqual(extensionToolEntries().map((e) => e.name), ['x'], 'the newer x survives a stale dispose');
});

test('A41-9 — disposeExtensionHost unwinds every contribution and is idempotent', () => {
  resetExtensionContributions();
  const host = createExtensionHost('ext-a', '/tmp', '1');
  host.registerTool(toolDef('t1'));
  host.registerTool(toolDef('t2'));
  host.registerPanel({ id: 'panel-1', title: 'Panel 1' });
  assert.equal(extensionToolEntries().length, 2);
  assert.equal(extensionPanels().length, 1);

  const count = disposeExtensionHost(host);
  assert.equal(count, 3, 'all three contributions disposed');
  assert.deepEqual(extensionToolEntries(), []);
  assert.deepEqual(extensionPanels(), []);

  // A second unload is a no-op (the tracked disposers were drained).
  assert.equal(disposeExtensionHost(host), 0);
});

test('A41-9 — disposeExtensionHost tears down in reverse (LIFO): a re-registration is removed before what it shadowed', () => {
  resetExtensionContributions();
  const host = createExtensionHost('ext-a', '/tmp', '1');
  // Two panels sharing an id: the second REPLACES the first (registry keys panels
  // by id). disposeExtensionHost pops the newer disposer first (removing the live
  // v2), then the stale v1 disposer runs as a no-op — the registry ends empty and
  // never throws. Forward order would also end empty here, but LIFO is what keeps
  // side-effecting disposers (provider sync) unwinding newest-first.
  host.registerPanel({ id: 'p', title: 'v1' });
  host.registerPanel({ id: 'p', title: 'v2' });
  assert.deepEqual(extensionPanels().map((p) => p.title), ['v2']);

  const count = disposeExtensionHost(host);
  assert.equal(count, 2);
  assert.deepEqual(extensionPanels(), [], 'both panel handles unwound cleanly');
});
