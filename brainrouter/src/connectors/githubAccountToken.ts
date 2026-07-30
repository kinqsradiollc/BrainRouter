import { open, seal } from "../security/secretBox.js";

/** Public GitHub App client id bundled with BrainRouter's device-flow client.
 * A self-hosted deployment can replace it without changing stored credentials. */
export const DEFAULT_GITHUB_APP_CLIENT_ID = "Iv23ligghGTjBPtQEkiq";

export function githubAppClientId(): string {
  return process.env.BRAINROUTER_GITHUB_APP_CLIENT_ID?.trim() || DEFAULT_GITHUB_APP_CLIENT_ID;
}

export interface GithubAccountToken {
  accessToken: string;
  login: string;
  scope: string;
  connectedAt: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshTokenExpiresAt?: string;
  refreshedAt?: string;
  flow?: "device" | "web";
}

/** GitHub OAuth-App tokens use `/user/repos`; only GitHub-App device tokens can
 * call `/user/installations`. Keeping this decision on the credential prevents a
 * bundled device client id from misclassifying a valid web token as an App token. */
export function githubRepositoryAccessMode(token: Pick<GithubAccountToken, "flow">): "installations" | "user" {
  return token.flow === "device" ? "installations" : "user";
}

interface GithubAccountTokenStore {
  getSetting<T = unknown>(key: string): Promise<T | null>;
  setSetting?<T = unknown>(key: string, value: T): Promise<void>;
}

interface GithubTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
}

interface GithubAccountTokenResolutionOptions {
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  /** Refresh before the access token actually expires so a review cannot lose
   * authorization halfway through its GitHub API sequence. */
  refreshLeewayMs?: number;
}

const refreshInFlight = new Map<string, Promise<GithubAccountToken | null>>();

function isoAfter(nowMs: number, seconds: unknown): string | undefined {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(nowMs + value * 1000).toISOString() : undefined;
}

/** Convert a GitHub device/web token response into the sealed record contract.
 * Refresh-token material never crosses an API or renderer boundary. */
export function githubAccountTokenFromResponse(
  response: GithubTokenResponse,
  account: Pick<GithubAccountToken, "login" | "connectedAt"> & Partial<Pick<GithubAccountToken, "scope" | "flow">>,
  nowMs = Date.now(),
): GithubAccountToken | null {
  const accessToken = typeof response.access_token === "string" ? response.access_token.trim() : "";
  if (!accessToken) return null;
  const refreshToken = typeof response.refresh_token === "string" ? response.refresh_token.trim() : "";
  const expiresAt = isoAfter(nowMs, response.expires_in);
  const refreshTokenExpiresAt = isoAfter(nowMs, response.refresh_token_expires_in);
  return {
    accessToken,
    login: account.login,
    scope: typeof response.scope === "string" ? response.scope : (account.scope ?? ""),
    connectedAt: account.connectedAt,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
    ...(account.flow ? { flow: account.flow } : {}),
  };
}

export function githubAccountTokenSettingKey(userId: string): string {
  return `connectorToken:github:${userId}`;
}

/** Read the per-user GitHub connector credential from the shared sealed setting.
 * Callers receive it only inside the backend process; renderer/API responses must
 * continue returning connection metadata rather than this record. */
export async function readGithubAccountToken(
  store: GithubAccountTokenStore,
  userId: string,
): Promise<GithubAccountToken | null> {
  const id = userId.trim();
  if (!id) return null;
  const record = await store.getSetting<{ sealed?: unknown }>(githubAccountTokenSettingKey(id));
  if (typeof record?.sealed !== "string" || !record.sealed) return null;
  try {
    const parsed = JSON.parse(open(record.sealed)) as Partial<GithubAccountToken>;
    const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "";
    if (!accessToken) return null;
    return {
      accessToken,
      login: typeof parsed.login === "string" ? parsed.login : "",
      scope: typeof parsed.scope === "string" ? parsed.scope : "",
      connectedAt: typeof parsed.connectedAt === "string" ? parsed.connectedAt : "",
      ...(typeof parsed.refreshToken === "string" && parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
      ...(typeof parsed.expiresAt === "string" && parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
      ...(typeof parsed.refreshTokenExpiresAt === "string" && parsed.refreshTokenExpiresAt ? { refreshTokenExpiresAt: parsed.refreshTokenExpiresAt } : {}),
      ...(typeof parsed.refreshedAt === "string" && parsed.refreshedAt ? { refreshedAt: parsed.refreshedAt } : {}),
      ...(parsed.flow === "device" || parsed.flow === "web" ? { flow: parsed.flow } : {}),
    };
  } catch {
    return null;
  }
}

/** Resolve a usable account token, rotating GitHub App user tokens in place.
 * Device-flow refreshes need only the public client id; web-flow refreshes also
 * require the caller-provided client secret. Failures return the existing record
 * so the normal authenticated probe reports a reconnect state instead of falsely
 * claiming there is no saved connection. */
export async function resolveGithubAccountToken(
  store: GithubAccountTokenStore,
  userId: string,
  options: GithubAccountTokenResolutionOptions = {},
): Promise<GithubAccountToken | null> {
  const id = userId.trim();
  const existing = await readGithubAccountToken(store, id);
  if (!existing || !id) return existing;

  const nowMs = options.nowMs?.() ?? Date.now();
  const expiresAtMs = existing.expiresAt ? Date.parse(existing.expiresAt) : Number.POSITIVE_INFINITY;
  const leeway = Math.max(0, options.refreshLeewayMs ?? 5 * 60_000);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs + leeway) return existing;
  const refreshExpiresAtMs = existing.refreshTokenExpiresAt ? Date.parse(existing.refreshTokenExpiresAt) : Number.POSITIVE_INFINITY;
  if (!existing.refreshToken || !store.setSetting || (Number.isFinite(refreshExpiresAtMs) && refreshExpiresAtMs <= nowMs)) return existing;

  const key = githubAccountTokenSettingKey(id);
  const active = refreshInFlight.get(key);
  if (active) return active;
  const refresh = (async (): Promise<GithubAccountToken | null> => {
    try {
      const clientId = options.clientId?.trim() || githubAppClientId();
      if (!clientId || (existing.flow === "web" && !options.clientSecret)) return existing;
      const body = new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: existing.refreshToken!,
        ...(existing.flow === "web" && options.clientSecret ? { client_secret: options.clientSecret } : {}),
      });
      const response = await (options.fetchImpl ?? fetch)("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) return existing;
      const payload = await response.json() as GithubTokenResponse;
      const rotated = githubAccountTokenFromResponse(payload, {
        login: existing.login,
        scope: existing.scope,
        connectedAt: existing.connectedAt,
        flow: existing.flow,
      }, nowMs);
      if (!rotated) return existing;
      const next: GithubAccountToken = { ...rotated, refreshedAt: new Date(nowMs).toISOString() };
      await store.setSetting!(key, { sealed: seal(JSON.stringify(next)) });
      return next;
    } catch {
      return existing;
    }
  })();
  refreshInFlight.set(key, refresh);
  try { return await refresh; }
  finally { refreshInFlight.delete(key); }
}
