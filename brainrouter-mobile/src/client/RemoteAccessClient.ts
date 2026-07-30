/**
 * Account remote-access client (spec §9, Task 24) — the PRIMARY mobile flow.
 * Signed in with BrainRouter, the phone enrolls its own Ed25519 key, discovers
 * the account's enrolled laptops (with real presence), requests scoped grants,
 * and obtains 30–60 s single-use relay tickets for the broker.
 *
 * Credential rules: the account bearer and the rotating device refresh token
 * only travel in HTTPS Authorization headers here — never in relay traffic.
 * SecureStore holds only rotating device credentials (see storage/credentials).
 */
import {
  b64url,
  createSigningKeyPair,
  fromB64url,
  randomToken,
  signDetached,
  signingKeyPairFromSecret,
} from '../protocol/crypto';

export interface RemoteSecretsPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RemoteDesktopSummary {
  id: string;
  displayName: string;
  presence: 'online' | 'offline';
  lastSeenAt: string | null;
  status: string;
}

export interface RemoteGrantSummary {
  id: string;
  desktopDeviceId: string;
  scopes: string[];
  approvalStatus: 'pending' | 'approved' | 'denied';
  expiresAt: string;
}

export interface RelayTicketGrant {
  relayTicket: string;
  relaySessionId: string;
  scopes: string[];
  presentingDeviceId: string;
  peerDeviceId: string;
  expiresAt: string;
}

const KEYS = {
  signSecret: 'remote.sign.secretKey',
  installationId: 'remote.installationId',
  deviceId: 'remote.deviceId',
  deviceSessionId: 'remote.deviceSessionId',
  refreshToken: 'remote.refreshToken',
} as const;

/** Credentials travel only over https (loopback allowed in dev) — CWE-319. */
function safeBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(base); } catch { throw new Error('Enter a valid server URL.'); }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new Error('Server URL must use https.');
  }
  return base;
}

export class RemoteAccessClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly secrets: RemoteSecretsPort,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
    return this.fetchImpl(`${safeBase(this.baseUrl)}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      redirect: 'error',
    });
  }

  async isEnrolled(): Promise<boolean> {
    return Boolean(await this.secrets.get(KEYS.deviceId) && await this.secrets.get(KEYS.refreshToken));
  }

  async deviceId(): Promise<string | null> {
    return this.secrets.get(KEYS.deviceId);
  }

  async deviceSessionId(): Promise<string | null> {
    return this.secrets.get(KEYS.deviceSessionId);
  }

  /** Enroll this phone's Ed25519 key: challenge → detached signature → session. */
  async enroll(displayName: string): Promise<{ deviceId: string }> {
    let installationId = await this.secrets.get(KEYS.installationId);
    if (!installationId) {
      installationId = `phone-${randomToken(16)}`;
      await this.secrets.set(KEYS.installationId, installationId);
    }
    let signSecret = await this.secrets.get(KEYS.signSecret);
    if (!signSecret) {
      const pair = createSigningKeyPair();
      signSecret = b64url(pair.secretKey);
      await this.secrets.set(KEYS.signSecret, signSecret);
    }
    const pair = signingKeyPairFromSecret(fromB64url(signSecret));
    const publicKey = `ed25519:${b64url(pair.publicKey)}`;

    const challengeRes = await this.call('/api/remote/devices/enroll/challenge', {
      method: 'POST',
      body: { installationId, kind: 'mobile', displayName: displayName.slice(0, 120) || 'BrainRouter Mobile', publicKey },
    });
    if (!challengeRes.ok) throw new Error('Enrollment challenge failed — check your sign-in.');
    const challenge = (await challengeRes.json()) as { challengeId: string; challenge: string };

    const refreshToken = randomToken(48);
    const completeRes = await this.call('/api/remote/devices/enroll/complete', {
      method: 'POST',
      body: {
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        signature: signDetached(fromB64url(challenge.challenge), pair.secretKey),
        refreshToken,
      },
    });
    if (!completeRes.ok) throw new Error('Enrollment could not be completed.');
    const completed = (await completeRes.json()) as { device?: { id?: string }; deviceSession?: { id?: string } };
    if (!completed.device?.id || !completed.deviceSession?.id) throw new Error('Enrollment returned an incomplete device.');
    await this.secrets.set(KEYS.deviceId, completed.device.id);
    await this.secrets.set(KEYS.deviceSessionId, completed.deviceSession.id);
    await this.secrets.set(KEYS.refreshToken, refreshToken);
    return { deviceId: completed.device.id };
  }

  /** Rotate the device refresh token; reuse detection is server-side. */
  async rotateSession(): Promise<boolean> {
    const current = await this.secrets.get(KEYS.refreshToken);
    if (!current) return false;
    const next = randomToken(48);
    const res = await this.call('/api/remote/device-sessions/rotate', {
      method: 'POST',
      body: { refreshToken: current, nextRefreshToken: next },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { session?: { id?: string } };
    if (body.session?.id) await this.secrets.set(KEYS.deviceSessionId, body.session.id);
    await this.secrets.set(KEYS.refreshToken, next);
    return true;
  }

  /** The account's enrolled laptops with live presence — no IPs or endpoints. */
  async listDesktops(): Promise<RemoteDesktopSummary[]> {
    const res = await this.call('/api/remote/desktops');
    if (!res.ok) throw new Error('Could not load your desktops.');
    const data = (await res.json()) as { desktops?: Array<Record<string, unknown>> };
    return (data.desktops ?? []).map((d) => ({
      id: String(d.id ?? ''),
      displayName: String(d.displayName ?? 'Desktop'),
      presence: d.presence === 'online' ? 'online' : 'offline',
      lastSeenAt: typeof d.lastSeenAt === 'string' ? d.lastSeenAt : null,
      status: String(d.status ?? 'active'),
    }));
  }

  async requestGrant(desktopDeviceId: string, scopes: string[]): Promise<RemoteGrantSummary> {
    const mobileDeviceId = await this.secrets.get(KEYS.deviceId);
    if (!mobileDeviceId) throw new Error('Enroll this phone first.');
    const res = await this.call(`/api/remote/desktops/${encodeURIComponent(desktopDeviceId)}/grants`, {
      method: 'POST',
      body: { mobileDeviceId, scopes },
    });
    if (!res.ok) throw new Error('Could not request access to this desktop.');
    const body = (await res.json()) as { grant?: RemoteGrantSummary };
    if (!body.grant?.id) throw new Error('Grant request returned no grant.');
    return body.grant;
  }

  async listGrants(): Promise<RemoteGrantSummary[]> {
    const res = await this.call('/api/remote/grants');
    if (!res.ok) return [];
    const body = (await res.json()) as { grants?: RemoteGrantSummary[] };
    return body.grants ?? [];
  }

  /** A fresh single-use relay ticket for one approved grant (every connect/reconnect). */
  async requestRelayTicket(desktopDeviceId: string, grantId: string, scopes: string[]): Promise<RelayTicketGrant> {
    const [mobileDeviceId, deviceSessionId] = await Promise.all([
      this.secrets.get(KEYS.deviceId),
      this.secrets.get(KEYS.deviceSessionId),
    ]);
    if (!mobileDeviceId || !deviceSessionId) throw new Error('Enroll this phone first.');
    const res = await this.call(`/api/remote/desktops/${encodeURIComponent(desktopDeviceId)}/sessions`, {
      method: 'POST',
      body: { mobileDeviceId, grantId, deviceSessionId, scopes },
    });
    if (!res.ok) throw new Error('Could not start a remote session.');
    return (await res.json()) as RelayTicketGrant;
  }
}
