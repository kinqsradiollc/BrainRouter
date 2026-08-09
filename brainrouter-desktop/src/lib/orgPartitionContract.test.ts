/**
 * ADR-032 D8 — the partition writer must live in the process that LEARNS.
 *
 * This is a wiring test rather than a logic test, because the bug it exists to
 * catch typechecks, passes every unit test, and does nothing: the meetings
 * bridge runs in Electron main, the Agent runs in the utility host, and those
 * are separate processes with separate `cachedRawCli` module state. A
 * `saveConfig` + `_resetCliKnobsCache()` performed in main writes the file and
 * leaves the learning process reading its boot-time cache — the org changes on
 * disk and never in the only place that consults it.
 *
 * Asserted against source text on purpose, and living under `src/` because that
 * is the half of the desktop suite that runs from SOURCE (the electron half
 * runs from `dist-electron`, where no `.ts` file exists to read). There is no
 * runtime seam that would notice this; the failure is which process a handler
 * is registered in.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

test('the active-org writer is registered in the host, not the main-process bridge', () => {
  const hostQueries = read('../../electron/host/queries.ts');
  const host = read('../../electron/host.ts');
  const main = read('../../electron/main.ts');
  const meetings = read('../../electron/meetingsBridge.ts');
  const orgContext = read('./orgContext.tsx');

  // The handler lives in the host and crosses the serialized Agent/transport
  // replacement boundary instead of changing config underneath a live Agent.
  assert.match(hostQueries, /'account-set-active-org':/);
  assert.match(hostQueries, /'account-set-active-org':[\s\S]{0,800}withAccountOrgId\(/);
  assert.match(hostQueries, /'account-set-active-org':[\s\S]{0,1000}await rebindActiveAccountOrg\(/);
  const rebindAt = host.indexOf('await core.rebindTenant');
  const reconnectAt = host.indexOf('await mcpClient.connectOne', rebindAt);
  const respawnAt = host.indexOf('return spawnAgent(sessionKey)', reconnectAt);
  assert.ok(rebindAt >= 0 && reconnectAt > rebindAt && respawnAt > reconnectAt);
  assert.match(host, /new Agent\(mcpClient,[\s\S]{0,220}learnedTenant: learnedTenant\(\)/);
  assert.match(host, /validateTurn:[\s\S]{0,180}activeTenantBindingError\(\)/);
  assert.match(hostQueries, /'action:learning-revert':[\s\S]{0,180}activeTenantBindingError\(\)/);

  // The selection is app-global, so main fans it out to every pooled host, not
  // only the active workspace process that received the renderer query.
  assert.match(main, /isActiveOrgSelectionQuery\(raw\)[\s\S]{0,500}broadcastActiveOrgSelection\(/);
  assert.match(main, /liveHosts[\s\S]{0,180}wins\.values\(\)[\s\S]{0,180}candidate\.hosts\.values\(\)/);
  assert.match(main, /isInternalActiveOrgResult\(msg\)/);
  assert.match(main, /webContents\.send\('active-org-changed'/);

  // And NOT in the ipcMain bridge, which is the wrong process for this write.
  assert.doesNotMatch(meetings, /setActiveOrg/);
  assert.doesNotMatch(meetings, /_resetCliKnobsCache/);

  // The renderer addresses the host channel by that exact name.
  assert.match(orgContext, /hostQuery\('account-set-active-org',\s*\{\s*orgId/);
  assert.match(orgContext, /onActiveOrgChanged\?\.\(/);
});
