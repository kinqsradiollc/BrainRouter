import { open } from "../security/secretBox.js";

export const GITHUB_OAUTH_APP_SETTING_KEY = "connectorOAuthApp:github";

export interface GithubOAuthAppSetting {
  clientId: string;
  clientSecretSealed: string;
  redirectBase?: string;
}

export interface ResolvedGithubOAuthApp {
  clientId: string;
  clientSecret: string;
  redirectBase?: string;
}

interface SettingsReader {
  getSetting<T = unknown>(key: string): Promise<T | null>;
}

export async function readGithubOAuthApp(
  store: SettingsReader,
): Promise<GithubOAuthAppSetting | null> {
  const setting = await store.getSetting<GithubOAuthAppSetting>(GITHUB_OAUTH_APP_SETTING_KEY);
  return setting?.clientId?.trim() ? setting : null;
}

/** Resolve the deployment OAuth App without ever returning its sealed form to a
 * caller. This is shared by the account routes and the org connector broker so
 * an admin-configured GitHub app has one source of truth. */
export async function resolveGithubOAuthApp(
  store: SettingsReader,
): Promise<ResolvedGithubOAuthApp | null> {
  const setting = await readGithubOAuthApp(store);
  if (!setting) return null;
  let clientSecret = "";
  if (setting.clientSecretSealed) {
    try { clientSecret = open(setting.clientSecretSealed); } catch { clientSecret = ""; }
  }
  return {
    clientId: setting.clientId.trim(),
    clientSecret,
    ...(setting.redirectBase?.trim() ? { redirectBase: setting.redirectBase.trim() } : {}),
  };
}
