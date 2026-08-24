// ADR-041 A41-11 / D11 — layered profile overlays that target composition rows by id.
// Prove the resolver folds an ordered overlay stack onto a base with per-row
// provenance (later layers win), and the two derived profiles resolve as declared.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProfileComposition,
  resolveDerivedProfile,
  derivedProfileIds,
  DERIVED_PROFILES,
  type ProfileOverlay,
} from '../runtime/profileOverlay.js';
import { HOST_PROFILES } from '../runtime/hostProfiles.js';

test('A41-11 — an unoverlaid row keeps the base value and the base layer', () => {
  const resolved = resolveProfileComposition(HOST_PROFILES.server, []);
  const providers = resolved.rows.find((r) => r.id === 'providers');
  assert.equal(providers?.value, true);
  assert.equal(providers?.layer, 'base');
  // Every row is attributed to `base` when there are no overlays.
  assert.ok(resolved.rows.every((r) => r.layer === 'base'));
});

test('A41-11 — an overlaid row takes the overlay value and is tagged by that layer', () => {
  const overlay: ProfileOverlay = {
    id: 'headless', base: 'server', description: 'x', surfaces: { apiRoutes: false },
  };
  const resolved = resolveProfileComposition(HOST_PROFILES.server, [overlay]);
  const api = resolved.rows.find((r) => r.id === 'apiRoutes');
  assert.equal(api?.value, false);
  assert.equal(api?.layer, 'overlay:headless');
  // A row the overlay did not touch stays base.
  assert.equal(resolved.rows.find((r) => r.id === 'mcpTools')?.layer, 'base');
});

test('A41-11 — later layers win when two overlays touch the same row id', () => {
  const a: ProfileOverlay = { id: 'a', base: 'cli', description: 'x', surfaces: { slashCommands: false } };
  const b: ProfileOverlay = { id: 'b', base: 'cli', description: 'x', surfaces: { slashCommands: true } };
  const resolved = resolveProfileComposition(HOST_PROFILES.cli, [a, b]);
  const cmds = resolved.rows.find((r) => r.id === 'slashCommands');
  assert.equal(cmds?.value, true);
  assert.equal(cmds?.layer, 'overlay:b');
});

test('A41-11 — the resolver emits rows in the fixed surface order', () => {
  const resolved = resolveProfileComposition(HOST_PROFILES.cli, []);
  assert.deepEqual(
    resolved.rows.map((r) => r.id),
    ['agentTools', 'slashCommands', 'mcpTools', 'apiRoutes', 'panels', 'providers'],
  );
});

test('A41-11 — minimal resolves to the server surfaces with apiRoutes overlaid off', () => {
  const minimal = resolveDerivedProfile('minimal');
  assert.ok(minimal);
  assert.equal(minimal!.base, 'server');
  const api = minimal!.rows.find((r) => r.id === 'apiRoutes');
  assert.equal(api?.value, false);
  assert.equal(api?.layer, 'overlay:minimal');
  // The base server surfaces it did NOT touch survive: mcpTools + providers on.
  assert.equal(minimal!.rows.find((r) => r.id === 'mcpTools')?.value, true);
  assert.equal(minimal!.rows.find((r) => r.id === 'providers')?.value, true);
});

test('A41-11 — test resolves to the cli surfaces with slashCommands overlaid off', () => {
  const derived = resolveDerivedProfile('test');
  assert.ok(derived);
  assert.equal(derived!.base, 'cli');
  assert.equal(derived!.rows.find((r) => r.id === 'slashCommands')?.value, false);
  assert.equal(derived!.rows.find((r) => r.id === 'agentTools')?.value, true);
});

test('A41-11 — derivedProfileIds lists the built-ins and an unknown id is undefined', () => {
  assert.deepEqual(derivedProfileIds(), ['minimal', 'test']);
  assert.equal(resolveDerivedProfile('nope'), undefined);
  // Every declared derived profile resolves.
  for (const id of Object.keys(DERIVED_PROFILES)) {
    assert.ok(resolveDerivedProfile(id), `${id} resolves`);
  }
});
