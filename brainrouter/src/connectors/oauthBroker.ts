/**
 * ADR-016 C2 — server-side OAuth broker core (pure + injectable).
 *
 * The desktop/dashboard no longer hold OAuth client secrets: the BACKEND runs the
 * OAuth dance for every connector source. This module is the provider-agnostic
 * heart of it — a per-source endpoint registry, an HMAC-signed short-TTL `state`
 * that binds the initiating user + a PKCE verifier (so a stolen callback can't be
 * replayed for another user), and the code→token exchange. Everything is pure or
 * fetch-injected so it unit-tests without a network or Postgres.
 *
 * `localhost` callbacks are allowed by GitHub et al., so a self-hosted backend is
 * the callback target with no public tunnel.
 */
import crypto from 'node:crypto';

export interface OAuthProvider {
  /** github, gitlab, slack, google-drive, gmail, notion, linear, jira, confluence */
  authorizeUrl: string;
  tokenUrl: string;
  /** Default scopes if the connector doesn't override. */
  scopes: string[];
  /** Providers that require PKCE (S256). GitHub OAuth Apps don't, but it's harmless. */
  usesPkce?: boolean;
  /** Extra static params on the authorize URL (e.g. Google's access_type=offline). */
  authorizeExtra?: Record<string, string>;
  /** Provider-specific scope delimiter (OAuth itself leaves this extensible). */
  scopeSeparator?: string;
}

/** The subset of connector sources that authorize via OAuth. API-key sources
 *  (filesystem, web, mcp) never appear here. Extend as providers are enabled. */
export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:org'],
  },
  gitlab: {
    authorizeUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    scopes: ['read_api', 'read_repository'],
    usesPkce: true,
  },
  slack: {
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:history', 'channels:read', 'files:read'],
    scopeSeparator: ',',
  },
  'google-drive': {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    usesPkce: true,
    authorizeExtra: { access_type: 'offline', prompt: 'consent' },
  },
  gmail: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    usesPkce: true,
    authorizeExtra: { access_type: 'offline', prompt: 'consent' },
  },
  notion: {
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
  },
  linear: {
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: ['read'],
    usesPkce: true,
    scopeSeparator: ',',
  },
};

export function isOAuthSource(source: string): boolean {
  return Object.prototype.hasOwnProperty.call(OAUTH_PROVIDERS, source);
}

// ── PKCE ──────────────────────────────────────────────────────────────────────

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface Pkce { verifier: string; challenge: string; method: 'S256' }

export function makePkce(randomBytes: (n: number) => Buffer = crypto.randomBytes): Pkce {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

// ── Signed state ────────────────────────────────────────────────────────────

export interface OAuthState {
  /** Who started the flow — the callback stores the token for THIS user only. */
  userId: string;
  orgId?: string;
  source: string;
  /** Connector this authorizes (existing) or a marker to create one. */
  connectorId?: string;
  /** PKCE verifier — held server-side in the state, never sent to the browser bar
   *  beyond the signed opaque blob. */
  verifier?: string;
  /** Epoch seconds the state was minted (TTL enforced on verify). */
  iat: number;
}

/** HMAC-SHA256 sign a state payload → `base64url(json).base64url(sig)`. */
export function signState(state: OAuthState, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(state)));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

/** Verify + decode a signed state; null if tampered, malformed, or older than ttl. */
export function verifyState(token: string, secret: string, ttlSec = 600, nowSec = Math.floor(Date.now() / 1000)): OAuthState | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  // Constant-time compare (equal length required).
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let state: OAuthState;
  try { state = JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as OAuthState; }
  catch { return null; }
  if (typeof state.iat !== 'number' || nowSec - state.iat > ttlSec || state.iat - nowSec > 60) return null;
  if (!state.userId || !state.source) return null;
  return state;
}

// ── Authorize URL + token exchange ────────────────────────────────────────────

export function buildAuthorizeUrl(source: string, clientId: string, redirectUri: string, state: string, scopes: string[], pkceChallenge?: string): string {
  const p = OAUTH_PROVIDERS[source];
  if (!p) throw new Error(`unknown OAuth source: ${source}`);
  const url = new URL(p.authorizeUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (scopes.length ? scopes : p.scopes).join(p.scopeSeparator ?? ' '));
  url.searchParams.set('state', state);
  if (p.usesPkce && pkceChallenge) { url.searchParams.set('code_challenge', pkceChallenge); url.searchParams.set('code_challenge_method', 'S256'); }
  for (const [k, v] of Object.entries(p.authorizeExtra ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

export interface TokenSet { accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string; raw?: unknown }

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string; ok?: boolean; authed_user?: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } };

function tokenSet(source: string, data: TokenResponse, now: number): TokenSet {
  const accessToken = data.access_token ?? (source === 'slack' ? data.authed_user?.access_token : undefined);
  if (data.error || data.ok === false || !accessToken) {
    throw new Error(`${source} token exchange error: ${data.error_description ?? data.error ?? 'no access_token'}`);
  }
  return {
    accessToken,
    refreshToken: data.refresh_token ?? (source === 'slack' ? data.authed_user?.refresh_token : undefined),
    expiresAt: typeof (data.expires_in ?? (source === 'slack' ? data.authed_user?.expires_in : undefined)) === 'number'
      ? new Date((now + (data.expires_in ?? data.authed_user!.expires_in!)) * 1000).toISOString()
      : undefined,
    scope: data.scope ?? (source === 'slack' ? data.authed_user?.scope : undefined),
    raw: data,
  };
}

/** Exchange an auth code for tokens. `fetchImpl` injected for tests. */
export async function exchangeCode(
  source: string,
  args: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier?: string },
  deps: { fetchImpl: typeof fetch; nowSec?: () => number } = { fetchImpl: fetch },
): Promise<TokenSet> {
  const p = OAUTH_PROVIDERS[source];
  if (!p) throw new Error(`unknown OAuth source: ${source}`);
  const body = new URLSearchParams({ client_id: args.clientId, code: args.code, redirect_uri: args.redirectUri, grant_type: 'authorization_code' });
  // Public PKCE clients intentionally have no secret. Some providers reject an
  // explicitly-empty client_secret even though omitting it is valid.
  if (args.clientSecret) body.set('client_secret', args.clientSecret);
  if (args.codeVerifier) body.set('code_verifier', args.codeVerifier);
  // Notion requires a JSON request body plus HTTP Basic authentication.  Its
  // endpoint otherwise returns an opaque 400, which made a correctly configured
  // connector look like a failed user authorization.
  const notion = source === 'notion';
  if (notion && !args.clientSecret) throw new Error('notion token exchange requires a client secret');
  const res = await deps.fetchImpl(p.tokenUrl, {
    method: 'POST',
    headers: notion
      ? { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString('base64')}` }
      : { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: notion
      ? JSON.stringify({ grant_type: 'authorization_code', code: args.code, redirect_uri: args.redirectUri })
      : body.toString(),
  });
  if (!res.ok) throw new Error(`${source} token exchange failed (HTTP ${res.status})`);
  const data = (await res.json()) as TokenResponse;
  const now = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  return tokenSet(source, data, now);
}

/** Refresh a short-lived OAuth token.  This follows each provider's normal form
 * exchange; Notion tokens are non-refreshable, so returning an explicit error is
 * safer than silently retrying a stale credential. */
export async function refreshToken(
  source: string,
  args: { clientId: string; clientSecret: string; refreshToken: string; redirectUri?: string },
  deps: { fetchImpl: typeof fetch; nowSec?: () => number } = { fetchImpl: fetch },
): Promise<TokenSet> {
  const provider = OAUTH_PROVIDERS[source];
  if (!provider) throw new Error(`unknown OAuth source: ${source}`);
  if (source === 'notion') throw new Error('Notion access tokens cannot be refreshed');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: args.refreshToken, client_id: args.clientId });
  if (args.clientSecret) body.set('client_secret', args.clientSecret);
  if (args.redirectUri) body.set('redirect_uri', args.redirectUri);
  const res = await deps.fetchImpl(provider.tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString(),
  });
  if (!res.ok) throw new Error(`${source} token refresh failed (HTTP ${res.status})`);
  return tokenSet(source, await res.json() as TokenResponse, (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))());
}
