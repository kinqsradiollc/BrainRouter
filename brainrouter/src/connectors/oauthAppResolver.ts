import type { ConnectorStore, ResolvedOAuthApp } from "./store.js";
import { resolveGithubOAuthApp } from "./githubOAuthApp.js";

interface SettingsReader {
  getSetting<T = unknown>(key: string): Promise<T | null>;
}

export interface RuntimeOAuthApp extends ResolvedOAuthApp {
  redirectBase?: string;
}

/** Resolve an org OAuth app, with the documented deployment-wide GitHub OAuth
 * App as the fallback. Other providers remain strictly org-scoped. */
export async function resolveConnectorOAuthApp(
  stores: { connectors: Pick<ConnectorStore, "getResolvedOAuthApp">; settings: SettingsReader },
  orgId: string,
  source: string,
): Promise<RuntimeOAuthApp | null> {
  const scoped = await stores.connectors.getResolvedOAuthApp(orgId, source);
  if (scoped?.clientId) return scoped;
  if (source !== "github") return null;
  const deployment = await resolveGithubOAuthApp(stores.settings);
  // GitHub's web OAuth-App exchange is confidential-client flow. A client id
  // without a decryptable sealed secret is incomplete and must not send users
  // into a callback that can never finish.
  if (!deployment?.clientId || !deployment.clientSecret) return null;
  return {
    orgId,
    source,
    clientId: deployment.clientId,
    clientSecret: deployment.clientSecret,
    scopes: "repo read:org",
    ...(deployment.redirectBase ? { redirectBase: deployment.redirectBase } : {}),
  };
}
