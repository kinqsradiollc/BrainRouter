/**
 * DESK-QUAL — Hermetic filesystem and environment for Electron qualification.
 *
 * Both development and packaged harnesses must boot without reading a user's
 * real config or state. Keep the valid first-run skeleton and home overrides in
 * one place so clean hosted runners exercise the same installation as local QA.
 */
import fs from 'node:fs';
import path from 'node:path';

export function prepareElectronHarnessLayout(temporaryRoot) {
  const profile = path.join(temporaryRoot, 'profile');
  const workspace = path.join(temporaryRoot, 'workspace');
  const home = path.join(temporaryRoot, 'home');
  const state = path.join(temporaryRoot, 'state');
  const configDir = path.join(home, '.config', 'brainrouter');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    `${JSON.stringify({ activeServer: '', servers: {} }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { profile, workspace, home, state };
}

export function createElectronHarnessEnvironment(layout, baseEnvironment = process.env) {
  return {
    ...baseEnvironment,
    HOME: layout.home,
    USERPROFILE: layout.home,
    BRAINROUTER_HOME: layout.state,
    BRAINROUTER_DESKTOP_WORKSPACE: layout.workspace,
  };
}
