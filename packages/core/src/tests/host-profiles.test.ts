// ADR-041 A41-11 — host profiles. Assert the four host profiles are well-formed
// and describe the surfaces each host actually composes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_PROFILES, resolveHostProfile, hostProfileIds } from '../runtime/hostProfiles.js';

test('A41-11 — exactly the four hosts have profiles, keyed by their own id', () => {
  assert.deepEqual(hostProfileIds(), ['cli', 'desktop', 'server', 'gateway']);
  for (const id of hostProfileIds()) {
    assert.equal(HOST_PROFILES[id].host, id, `${id} profile is keyed by its own id`);
    assert.ok(HOST_PROFILES[id].description.length > 10, `${id} has a real description`);
  }
});

test('A41-11 — resolveHostProfile returns the profile or undefined', () => {
  assert.equal(resolveHostProfile('gateway')?.host, 'gateway');
  assert.equal(resolveHostProfile('nope'), undefined);
});

test('A41-11 — every host composes providers; only the gateway composes NOTHING else', () => {
  for (const id of hostProfileIds()) {
    assert.equal(HOST_PROFILES[id].surfaces.providers, true, `${id} composes the provider catalog`);
  }
  // The gateway is a thin proxy — no agent tools, commands, MCP tools, API routes, or panels.
  const g = HOST_PROFILES.gateway.surfaces;
  assert.deepEqual(
    { agentTools: g.agentTools, slashCommands: g.slashCommands, mcpTools: g.mcpTools, apiRoutes: g.apiRoutes, panels: g.panels },
    { agentTools: false, slashCommands: false, mcpTools: false, apiRoutes: false, panels: false },
  );
});

test('A41-11 — the surface sets match each host\'s role', () => {
  // CLI = interactive agent; desktop = CLI + panels; server = MCP + API.
  assert.equal(HOST_PROFILES.cli.surfaces.agentTools, true);
  assert.equal(HOST_PROFILES.cli.surfaces.panels, false);
  assert.equal(HOST_PROFILES.desktop.surfaces.agentTools, true);
  assert.equal(HOST_PROFILES.desktop.surfaces.panels, true);
  assert.equal(HOST_PROFILES.server.surfaces.mcpTools, true);
  assert.equal(HOST_PROFILES.server.surfaces.apiRoutes, true);
  assert.equal(HOST_PROFILES.server.surfaces.agentTools, false);
});
