/**
 * D26-9 — packaged browser smoke bootstrap.
 *
 * The release verifier supplies an isolated profile and a result path inside
 * that profile. Ordinary launches never enable this surface.
 */
import path from 'node:path';

interface PackagedSmokeApp {
  readonly isPackaged: boolean;
  readonly commandLine: {
    appendSwitch(name: string, value?: string): void;
  };
}

export interface PackagedSmokeConfig {
  profile: string;
  result: string;
}

export function resolvePackagedSmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
): PackagedSmokeConfig | null {
  const profile = env.BRAINROUTER_PACKAGED_SMOKE_PROFILE;
  const result = env.BRAINROUTER_PACKAGED_SMOKE_RESULT;
  if (!profile || !result || !path.isAbsolute(profile) || !path.isAbsolute(result)) return null;
  const normalizedProfile = path.resolve(profile);
  const normalizedResult = path.resolve(result);
  if (path.dirname(normalizedResult) !== normalizedProfile) return null;
  return { profile: normalizedProfile, result: normalizedResult };
}

export function configurePackagedSmokeProfile(
  app: PackagedSmokeApp,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!app.isPackaged) return false;
  const config = resolvePackagedSmokeConfig(env);
  if (!config) return false;
  // Keep the release verifier out of the user's real Desktop profile. The
  // verifier owns this empty temporary directory and deletes it after the run.
  app.commandLine.appendSwitch('user-data-dir', config.profile);
  return true;
}
