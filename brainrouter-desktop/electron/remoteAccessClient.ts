/**
 * Enrolled-device relay client (spec §9, Task 23). The desktop enrolls a stable
 * Ed25519 installation key with the account backend, keeps a ROTATING device
 * refresh token in OS-protected storage, and opens OUTBOUND WSS connections to
 * the remote-relay edge with a single-use ticket presented in the first frame.
 *
 * Credential rules (spec §9.2): the account bearer and the device refresh token
 * only ever travel in HTTPS Authorization headers to the account API — never in
 * a WebSocket frame or URL. The only secret-adjacent value on the relay wire is
 * the 30–60 s single-use ticket. Attached broker sockets are handed to the
 * existing MobileRelayServer allowlist, so scope enforcement and E2EE are the
 * same as the LAN path.
 */
import { generateKeyPairSync, createPrivateKey, randomBytes, randomUUID, sign as edSign } from 'node:crypto';

export interface RemoteSecretsPort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface RemoteAccountFetchResult {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type RemoteAccountFetch = (path: string, init?: { method?: string; body?: string }) => Promise<RemoteAccountFetchResult | null>;

export interface BrokerSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
  once(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
}

export interface RemoteAccessClientDeps {
  /** Authenticated main-process call to the account backend (bearer stays here). */
  accountFetch: RemoteAccountFetch;
  /** OS-protected storage (safeStorage-backed in production). */
  secrets: RemoteSecretsPort;
  /** Broker base, e.g. wss://relay.brainrouter.ai — null when remote access is off. */
  relayUrl(): string | null;
  /** Hand an attached broker socket to the local E2EE/RPC allowlist. */
  attachLocal(socket: BrokerSocketLike): void;
  wsFactory(url: string): BrokerSocketLike;
  displayName?: () => string;
  random?: (size: number) => Buffer;
}

const KEYS = {
  installationId: 'remote.installationId',
  privateKey: 'remote.ed25519.privateKeyPem',
  publicKey: 'remote.ed25519.publicKey',
  deviceId: 'remote.deviceId',
  deviceSessionId: 'remote.deviceSessionId',
  sessionFamilyId: 'remote.sessionFamilyId',
  refreshToken: 'remote.refreshToken',
} as const;

const REVOKED_CLOSE_CODE = 4403;
const MAX_RECONNECT_DELAY_MS = 60_000;

interface EnrollChallengeResponse { challengeId: string; challenge: string }
interface EnrollCompleteResponse {
  device?: { id?: string };
  deviceSession?: { id?: string; familyId?: string };
}

function b64urlSignature(privateKeyPem: string, message: Buffer): string {
  return edSign(null, message, createPrivateKey(privateKeyPem)).toString('base64url');
}

export class RemoteAccessClient {
  private reconnectDelayMs = 1_000;
  private stopped = true;
  private activeSocket: BrokerSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: RemoteAccessClientDeps) {}

  /** Stable installation identity + Ed25519 keypair; created once, stored sealed. */
  ensureIdentity(): { installationId: string; publicKey: string } {
    let installationId = this.deps.secrets.get(KEYS.installationId);
    if (!installationId) {
      installationId = `desk-${randomUUID()}`;
      this.deps.secrets.set(KEYS.installationId, installationId);
    }
    let publicKey = this.deps.secrets.get(KEYS.publicKey);
    if (!publicKey || !this.deps.secrets.get(KEYS.privateKey)) {
      const pair = generateKeyPairSync('ed25519');
      const der = pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
      publicKey = `ed25519:${der.subarray(der.length - 32).toString('base64url')}`;
      this.deps.secrets.set(KEYS.privateKey, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
      this.deps.secrets.set(KEYS.publicKey, publicKey);
    }
    return { installationId, publicKey };
  }

  isEnrolled(): boolean {
    return Boolean(this.deps.secrets.get(KEYS.deviceId) && this.deps.secrets.get(KEYS.refreshToken));
  }

  deviceId(): string | null {
    return this.deps.secrets.get(KEYS.deviceId);
  }

  /** Explicit opt-in enrollment: challenge → device-key signature → rotating session. */
  async enroll(): Promise<{ deviceId: string }> {
    const identity = this.ensureIdentity();
    const random = this.deps.random ?? randomBytes;
    const challengeRes = await this.deps.accountFetch('/api/remote/devices/enroll/challenge', {
      method: 'POST',
      body: JSON.stringify({
        installationId: identity.installationId,
        kind: 'desktop',
        displayName: this.deps.displayName?.() ?? 'BrainRouter Desktop',
        publicKey: identity.publicKey,
      }),
    });
    if (!challengeRes?.ok) throw new Error('Remote enrollment challenge failed. Sign in and try again.');
    const challenge = (await challengeRes.json()) as EnrollChallengeResponse;
    const privateKeyPem = this.deps.secrets.get(KEYS.privateKey);
    if (!privateKeyPem) throw new Error('Remote device key is missing.');
    const refreshToken = random(48).toString('base64url');
    const completeRes = await this.deps.accountFetch('/api/remote/devices/enroll/complete', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        signature: b64urlSignature(privateKeyPem, Buffer.from(challenge.challenge, 'base64url')),
        refreshToken,
      }),
    });
    if (!completeRes?.ok) throw new Error('Remote enrollment could not be completed.');
    const completed = (await completeRes.json()) as EnrollCompleteResponse;
    const deviceId = completed.device?.id;
    const sessionId = completed.deviceSession?.id;
    const familyId = completed.deviceSession?.familyId;
    if (!deviceId || !sessionId || !familyId) throw new Error('Remote enrollment returned an incomplete device.');
    this.deps.secrets.set(KEYS.deviceId, deviceId);
    this.deps.secrets.set(KEYS.deviceSessionId, sessionId);
    this.deps.secrets.set(KEYS.sessionFamilyId, familyId);
    this.deps.secrets.set(KEYS.refreshToken, refreshToken);
    return { deviceId };
  }

  /** Rotate the device refresh token (reuse detection is server-side). */
  async rotateSession(): Promise<boolean> {
    const current = this.deps.secrets.get(KEYS.refreshToken);
    if (!current) return false;
    const next = (this.deps.random ?? randomBytes)(48).toString('base64url');
    const res = await this.deps.accountFetch('/api/remote/device-sessions/rotate', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: current, nextRefreshToken: next }),
    });
    if (!res?.ok) return false;
    const body = (await res.json()) as { session?: { id?: string; familyId?: string } };
    if (body.session?.id) this.deps.secrets.set(KEYS.deviceSessionId, body.session.id);
    if (body.session?.familyId) this.deps.secrets.set(KEYS.sessionFamilyId, body.session.familyId);
    this.deps.secrets.set(KEYS.refreshToken, next);
    return true;
  }

  /**
   * Elevated grants require this enrolled desktop's explicit signature over the
   * server-issued approval challenge — a signed confirmation, not a bare click.
   */
  async approveGrant(grantId: string): Promise<boolean> {
    const deviceId = this.deps.secrets.get(KEYS.deviceId);
    const privateKeyPem = this.deps.secrets.get(KEYS.privateKey);
    if (!deviceId || !privateKeyPem) return false;
    const grantsRes = await this.deps.accountFetch('/api/remote/grants');
    if (!grantsRes?.ok) return false;
    const grants = (await grantsRes.json()) as { grants?: Array<{ id?: string; approvalChallenge?: string | null }> };
    const grant = grants.grants?.find((g) => g.id === grantId);
    if (!grant?.approvalChallenge) return false;
    const signature = b64urlSignature(privateKeyPem, Buffer.from(grant.approvalChallenge, 'base64url'));
    const res = await this.deps.accountFetch(`/api/remote/grants/${encodeURIComponent(grantId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'approve', desktopDeviceId: deviceId, signature }),
    });
    return Boolean(res?.ok);
  }

  /**
   * Open (and keep) the outbound broker connection for an approved grant. Closes
   * permanently on revocation (4403); any other close schedules a reconnect with
   * a FRESH single-use ticket — a new relay epoch.
   */
  async connect(grantId: string, scopes: string[]): Promise<void> {
    this.stopped = false;
    await this.dial(grantId, scopes);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.activeSocket?.close(1000, 'remote access stopped');
    this.activeSocket = null;
  }

  private async dial(grantId: string, scopes: string[]): Promise<void> {
    if (this.stopped) return;
    const relayBase = this.deps.relayUrl();
    const deviceId = this.deps.secrets.get(KEYS.deviceId);
    const deviceSessionId = this.deps.secrets.get(KEYS.deviceSessionId);
    if (!relayBase || !deviceId || !deviceSessionId) return;
    const ticketRes = await this.deps.accountFetch(`/api/remote/grants/${encodeURIComponent(grantId)}/desktop-tickets`, {
      method: 'POST',
      body: JSON.stringify({ deviceSessionId, scopes }),
    });
    if (!ticketRes?.ok) {
      this.scheduleReconnect(grantId, scopes);
      return;
    }
    const ticket = (await ticketRes.json()) as { relayTicket?: string };
    if (!ticket.relayTicket) {
      this.scheduleReconnect(grantId, scopes);
      return;
    }
    // The URL carries no credential — the single-use ticket goes in frame one.
    const socket = this.deps.wsFactory(`${relayBase.replace(/\/+$/, '')}/remote-relay`);
    this.activeSocket = socket;
    socket.once('open', () => {
      socket.send(JSON.stringify({ kind: 'attach', ticket: ticket.relayTicket, deviceId }));
    });
    socket.once('message', () => {
      // First relay reply = attached. From here the socket speaks the existing
      // LAN protocol (E2EE pairing + scoped RPC) — hand it to the allowlist.
      this.reconnectDelayMs = 1_000;
      this.deps.attachLocal(socket);
    });
    socket.once('close', (...args: unknown[]) => {
      const code = typeof args[0] === 'number' ? args[0] : 0;
      this.activeSocket = null;
      if (code === REVOKED_CLOSE_CODE) {
        this.stopped = true;
        return;
      }
      this.scheduleReconnect(grantId, scopes);
    });
    socket.once('error', () => { /* close owns the retry */ });
  }

  private scheduleReconnect(grantId: string, scopes: string[]): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.dial(grantId, scopes);
    }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }
}
