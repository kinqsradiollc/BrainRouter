/**
 * GitHub App auth for the trigger bot — Phase 1 of the centralized-ingress plan.
 *
 * A single GitHub App (`brainrouter[bot]`) replaces per-workspace PATs for the
 * outbound trigger post-back: one synced bot identity, authenticating with
 * SHORT-LIVED per-installation tokens (~1h) instead of a long-lived broad PAT.
 *
 * Three pieces, all dependency-free (node:crypto for RS256 — no jsonwebtoken):
 *  - `buildAppJwt` — pure: the ~10-minute App JWT (RS256) used to talk to the
 *    `/app/*` endpoints. iat is backdated 60s for clock skew; exp is 9 min.
 *  - `mintInstallationToken` / `resolveInstallationId` — one REST call each,
 *    over an injected fetch (tests never touch the network).
 *  - `createInstallationTokenCache` — caches the installation token per
 *    installation id and refreshes it a few minutes before expiry.
 *
 * Nothing here throws for a delivery/auth problem in the production path: the
 * caller (the trigger post-back) treats an undefined token as "fall back to the
 * PAT", so a misconfigured App never breaks the local-first flow.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getRawCliKnobs } from '../../config/config.js';
import { ghHeaders } from './client.js';
import type { FetchLike } from './types.js';
import type { GithubAppCliKnobs } from '../../config/configTypes.js';
import { stripTrailingSlashes } from '../../util/trimEdges.js';

const DEFAULT_API_BASE = 'https://api.github.com';
/** Refresh the installation token when it is within this window of expiry. */
const REFRESH_SKEW_MS = 5 * 60_000;

export interface GithubAppCredentials {
  appId: string;
  /** RSA private-key PEM. */
  privateKey: string;
  installationId?: string;
  apiBase?: string;
}

/**
 * Harden `apiBase` against SSRF + credential exfiltration (CWE-918). The App JWT
 * and installation tokens are sent to this host, so an admin (or anyone who can
 * edit the org integration) could otherwise point it at cloud-metadata / internal
 * services or an attacker's server and leak the credential. Allow only an https
 * GitHub API host — the default or a GitHub Enterprise domain; reject non-https,
 * IP literals (loopback / private / link-local like 169.254.169.254), `localhost`,
 * and bare internal hostnames. Returns the trusted base (no trailing slash) or null.
 */
export function validateGithubApiBase(raw?: string | null): string | null {
  const s = (raw ?? '').trim();
  if (!s) return DEFAULT_API_BASE;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null; // no IP literals
  if (!host.includes('.')) return null; // require a real domain, not a bare internal name
  return stripTrailingSlashes(s);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build + RS256-sign the App JWT. Pure and clock-injected (nowSec) so tests are
 * deterministic. GitHub caps App-JWT lifetime at 10 min; we use 9 and backdate
 * `iat` 60s to tolerate minor clock skew between us and GitHub.
 */
export function buildAppJwt(creds: Pick<GithubAppCredentials, 'appId' | 'privateKey'>, nowSec: number): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSec - 60, exp: nowSec + 9 * 60, iss: String(creds.appId) };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(creds.privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

export interface InstallationToken {
  token: string;
  /** ISO expiry from GitHub (`expires_at`). */
  expiresAt: string;
  installationId: string;
}

export interface AppTokenDeps {
  fetchImpl: FetchLike;
  /** Seconds since epoch — injected so tests control JWT + refresh timing. */
  nowSec: () => number;
}

/** Resolve the installation id for a repo (or owner) via the App JWT. */
export async function resolveInstallationId(
  creds: GithubAppCredentials,
  target: { owner: string; repo?: string },
  deps: AppTokenDeps,
): Promise<string> {
  if (creds.installationId?.trim()) return creds.installationId.trim();
  const owner = target.owner.trim();
  if (!owner) throw new Error('GitHub App: cannot resolve installation without an owner');
  const base = validateGithubApiBase(creds.apiBase);
  if (!base) throw new Error('GitHub App: refusing an untrusted apiBase (must be an https GitHub API host)');
  const jwt = buildAppJwt(creds, deps.nowSec());
  const url = target.repo
    ? `${base}/repos/${owner}/${target.repo.trim()}/installation`
    : `${base}/users/${owner}/installation`;
  const res = await deps.fetchImpl(url, { headers: ghHeaders(jwt) });
  if (!res.ok) throw new Error(`GitHub App: cannot resolve installation for ${owner}/${target.repo ?? ''} (HTTP ${res.status})`);
  const data = (await res.json()) as { id?: number | string };
  if (data?.id === undefined || data.id === null) throw new Error('GitHub App: installation lookup returned no id');
  return String(data.id);
}

/** Exchange the App JWT for a fresh installation access token. */
export async function mintInstallationToken(
  creds: GithubAppCredentials,
  installationId: string,
  deps: AppTokenDeps,
): Promise<InstallationToken> {
  const base = validateGithubApiBase(creds.apiBase);
  if (!base) throw new Error('GitHub App: refusing an untrusted apiBase (must be an https GitHub API host)');
  const jwt = buildAppJwt(creds, deps.nowSec());
  const res = await deps.fetchImpl(`${base}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: ghHeaders(jwt),
  });
  if (!res.ok) throw new Error(`GitHub App: token mint failed for installation ${installationId} (HTTP ${res.status})`);
  const data = (await res.json()) as { token?: string; expires_at?: string };
  if (!data?.token?.trim()) throw new Error('GitHub App: token mint returned no token');
  return { token: data.token, expiresAt: data.expires_at ?? '', installationId };
}

export interface InstallationTokenCache {
  /** Fresh installation token for a repo, minting/refreshing as needed. */
  getToken(creds: GithubAppCredentials, target: { owner: string; repo?: string }): Promise<string>;
  /** Drop cached tokens (mainly for tests). */
  clear(): void;
}

/**
 * Per-installation token cache with refresh. Keyed by installation id, so two
 * repos under the same installation share one token. Refreshes when the token
 * is within {@link REFRESH_SKEW_MS} of `expires_at` (or has no expiry).
 */
export function createInstallationTokenCache(deps: AppTokenDeps): InstallationTokenCache {
  const cache = new Map<string, InstallationToken>();
  return {
    async getToken(creds, target) {
      const installationId = creds.installationId?.trim() || (await resolveInstallationId(creds, target, deps));
      const cached = cache.get(installationId);
      const nowMs = deps.nowSec() * 1000;
      const fresh = cached && cached.expiresAt && Date.parse(cached.expiresAt) - nowMs > REFRESH_SKEW_MS;
      if (cached && fresh) return cached.token;
      const minted = await mintInstallationToken(creds, installationId, deps);
      cache.set(installationId, minted);
      return minted.token;
    },
    clear() { cache.clear(); },
  };
}

/**
 * Read the configured GitHub App credentials (`cli.triggers.githubApp`), or
 * `undefined` when no App is configured. Resolves the private key from an inline
 * PEM or a `privateKeyPath` file (backend secret custody for hosted mode). Never
 * throws — an unreadable key file just means "no App" (→ PAT fallback).
 */
export function loadGithubAppCredentials(knobs?: GithubAppCliKnobs): GithubAppCredentials | undefined {
  const app = knobs ?? getRawCliKnobs().triggers?.githubApp;
  const appId = app?.appId?.trim();
  if (!appId) return undefined;
  let privateKey = app?.privateKey?.trim() || '';
  if (!privateKey && app?.privateKeyPath?.trim()) {
    try { privateKey = fs.readFileSync(app.privateKeyPath.trim(), 'utf8').trim(); } catch { return undefined; }
  }
  if (!privateKey) return undefined;
  return {
    appId,
    privateKey,
    installationId: app?.installationId?.trim() || undefined,
    apiBase: app?.apiBase?.trim() || undefined,
  };
}

/** Process-wide cache using the real clock + global fetch. */
export const githubAppTokens = createInstallationTokenCache({
  fetchImpl: fetch as unknown as FetchLike,
  nowSec: () => Math.floor(Date.now() / 1000),
});

/**
 * The high-level resolver the trigger post-back uses: an installation token for
 * `owner/repo` when a GitHub App is configured, else `undefined` (→ the caller
 * falls back to the PAT path). Never throws — a mint failure returns undefined.
 */
export async function resolveAppInstallationToken(repo: string): Promise<string | undefined> {
  const creds = loadGithubAppCredentials();
  if (!creds) return undefined;
  const [owner, name] = repo.split('/');
  if (!owner) return undefined;
  try {
    return await githubAppTokens.getToken(creds, { owner: owner.trim(), repo: name?.trim() || undefined });
  } catch {
    return undefined; // fall back to the PAT — never break the local-first flow
  }
}
