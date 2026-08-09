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
  const meetings = read('../../electron/meetingsBridge.ts');
  const orgContext = read('./orgContext.tsx');

  // The handler lives in the host, and resets the cache it just invalidated.
  assert.match(hostQueries, /'account-set-active-org':/);
  assert.match(hostQueries, /'account-set-active-org':[\s\S]{0,400}_resetCliKnobsCache\(\)/);
  // One implementation: the host uses the pure helper the electron tests cover.
  assert.match(hostQueries, /'account-set-active-org':[\s\S]{0,200}withAccountOrgId\(/);

  // And NOT in the ipcMain bridge, which is the wrong process for this write.
  assert.doesNotMatch(meetings, /setActiveOrg/);
  assert.doesNotMatch(meetings, /_resetCliKnobsCache/);

  // The renderer addresses the host channel by that exact name.
  assert.match(orgContext, /hostQuery\('account-set-active-org',\s*\{\s*orgId/);
});
