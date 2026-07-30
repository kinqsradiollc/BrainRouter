/**
 * D26-9 — packaged browser smoke bootstrap.
 *
 * Electron documents remote debugging as an app command-line switch installed
 * before `ready`. The release verifier supplies a short-lived loopback port;
 * ordinary launches never enable this surface.
 */
import path from 'node:path';

interface PackagedSmokeApp {
  readonly isPackaged: boolean;
  readonly commandLine: {
    appendSwitch(name: string, value?: string): void;
  };
}

export function resolvePackagedSmokePort(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1024 && port <= 65_535 ? port : null;
}

export function configurePackagedSmokeDevTools(
  app: PackagedSmokeApp,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!app.isPackaged) return false;
  const port = resolvePackagedSmokePort(env.BRAINROUTER_PACKAGED_SMOKE_PORT);
  const profile = env.BRAINROUTER_PACKAGED_SMOKE_PROFILE;
  if (port === null || !profile || !path.isAbsolute(profile)) return false;
  // Chromium 136+ refuses remote debugging against the default profile. The
  // verifier owns this empty temporary directory and deletes it after the run.
  app.commandLine.appendSwitch('user-data-dir', profile);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
  return true;
}
