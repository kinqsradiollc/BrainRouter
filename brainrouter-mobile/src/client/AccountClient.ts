/**
 * Account-based device discovery — the no-QR path.
 *
 * Signing into the SAME BrainRouter account is the trust root: the desktop
 * publishes its mobile-relay endpoints + public key into its active-session
 * metadata (`metadata.remoteRelay`), and the account-scoped `GET /api/sessions`
 * returns only the caller's own sessions. So a phone signed into the same account
 * lists the user's desktops here and pairs with `RelayClient.pairViaAccount`
 * (which presents this account token instead of a scanned QR token).
 */

export interface RemoteDesktop {
  sessionKey: string;
  name: string;
  workspaceRoot: string;
  endpoints: string[];
  serverPublicKey: string;
  lastSeenAt?: string;
}

export class AccountClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Sign in with email + password; returns a client holding the stable apiKey
   * (preferred) or jwt. `POST /api/auth/signin` → { jwt, apiKey, ... }. */
  static async signIn(baseUrl: string, email: string, password: string, fetchImpl: typeof fetch = fetch): Promise<AccountClient> {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error('Sign-in failed — check your email and password.');
    const data = (await res.json()) as { apiKey?: string; jwt?: string };
    const token = data.apiKey || data.jwt || '';
    if (!token) throw new Error('Sign-in did not return a usable credential.');
    return new AccountClient(baseUrl, token, fetchImpl);
  }

  /** The bearer this account presents to a desktop's relay for account-pairing. */
  get accountToken(): string { return this.token; }

  /** This account's desktops that currently advertise a reachable mobile relay. */
  async listDesktops(): Promise<RemoteDesktop[]> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/api/sessions`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error('Could not load your desktops.');
    const data = (await res.json()) as {
      sessions?: Array<{
        sessionKey?: string; clientKind?: string; workspaceRoot?: string; lastSeenAt?: string;
        metadata?: { remoteRelay?: { endpoints?: string[]; publicKey?: string } };
      }>;
    };
    return (data.sessions ?? [])
      .filter((s) => s.clientKind === 'electron-desktop'
        && Array.isArray(s.metadata?.remoteRelay?.endpoints) && s.metadata!.remoteRelay!.endpoints!.length > 0
        && typeof s.metadata?.remoteRelay?.publicKey === 'string' && !!s.metadata.remoteRelay.publicKey)
      .map((s) => ({
        sessionKey: s.sessionKey ?? '',
        name: (s.workspaceRoot ?? '').split(/[\\/]/).filter(Boolean).pop() || 'BrainRouter Desktop',
        workspaceRoot: s.workspaceRoot ?? '',
        endpoints: s.metadata!.remoteRelay!.endpoints!,
        serverPublicKey: s.metadata!.remoteRelay!.publicKey!,
        lastSeenAt: s.lastSeenAt,
      }));
  }
}
