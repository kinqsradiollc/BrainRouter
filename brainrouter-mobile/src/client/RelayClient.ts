import { createDeviceKeyPair, decryptPayload, encryptPayload, b64, fromB64 } from '../protocol/crypto';
import { parsePairingPayload, privateHost, type HostCredential, type PairingPayload, type RelayEvent } from '../protocol/types';
import type { CredentialStore } from '../storage/credentials';

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
}

type Listener = (event: RelayEvent | { type: 'connection'; state: 'connecting' | 'connected' | 'disconnected'; error?: string }) => void;

export class RelayClient {
  private socket?: SocketLike;
  private credential?: HostCredential;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<Listener>();
  private lastServerCounter = 0;
  private reconnectAttempt = 0;
  private intentionalClose = false;

  constructor(private readonly store: CredentialStore, private readonly socketFactory: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike) {}

  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /**
   * Attach an outbound broker connection (spec §9, Task 24): the single-use relay
   * ticket rides the FIRST frame — never the URL — and the socket then speaks the
   * normal LAN protocol end-to-end (the relay only splices opaque frames).
   */
  private async openBroker(broker: { url: string; ticket: string; deviceId: string }): Promise<SocketLike> {
    const socket = await this.openFirst([broker.url.replace(/\/+$/, '')]);
    const attached = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Relay attach timed out.')), 10_000);
      socket.onmessage = (event) => {
        clearTimeout(timer);
        try {
          const frame = JSON.parse(event.data) as { kind?: string };
          if (frame.kind === 'attached') resolve(); else reject(new Error('Relay refused the session.'));
        } catch { reject(new Error('Relay attach failed.')); }
      };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Relay connection failed.')); };
      socket.onclose = () => { clearTimeout(timer); reject(new Error('Relay closed during attach.')); };
    });
    socket.send(JSON.stringify({ kind: 'attach', ticket: broker.ticket, deviceId: broker.deviceId }));
    await attached;
    return socket;
  }

  /**
   * First-time pairing over the broker: NO bearer or pairing token on the wire —
   * both sides were already authenticated by grant-bound single-use tickets, and
   * the desktop signed the grant approval. The desktop's NaCl key arrives in the
   * `paired` reply, bound to that mutually authenticated session.
   */
  async pairViaBroker(broker: { url: string; ticket: string; deviceId: string }, name: string): Promise<HostCredential> {
    const socket = await this.openBroker(broker);
    return this.runPairingOn(socket, [], null, { broker: true }, name);
  }

  /** Connect to an already-paired desktop through the broker. Reconnects need a
   * FRESH single-use ticket, so broker closes surface to the app (no auto-retry). */
  async connectViaBroker(hostId: string, broker: { url: string; ticket: string; deviceId: string }): Promise<void> {
    this.intentionalClose = false;
    const credential = await this.store.get(hostId);
    if (!credential) throw new Error('Paired host not found.');
    this.credential = credential;
    this.emit({ type: 'connection', state: 'connecting' });
    const socket = await this.openBroker(broker);
    this.socket = socket;
    this.lastServerCounter = 0;
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onclose = () => this.emit({ type: 'connection', state: 'disconnected', error: 'Remote session ended — reconnect for a new session.' });
    socket.onerror = () => this.emit({ type: 'connection', state: 'disconnected', error: 'WebSocket error' });
    await this.sendAuth();
    this.reconnectAttempt = 0;
    this.emit({ type: 'connection', state: 'connected' });
  }

  /** Shared pairing handshake: open a relay endpoint, send a `pair` frame (with
   * either a QR `pairingToken` or an account token), decrypt the reply, persist. */
  private async runPairing(endpoints: string[], serverPublicKey: string, pairFields: Record<string, unknown>, name: string): Promise<HostCredential> {
    const socket = await this.openFirst(endpoints);
    return this.runPairingOn(socket, endpoints, serverPublicKey, pairFields, name);
  }

  /** Pairing over an already-open socket. When `serverPublicKey` is null (broker
   * pairing) it is read from the authenticated `paired` reply frame instead. */
  private async runPairingOn(socket: SocketLike, endpoints: string[], serverPublicKey: string | null, pairFields: Record<string, unknown>, name: string): Promise<HostCredential> {
    const pair = createDeviceKeyPair();
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Pairing timed out.')), 10_000);
      socket.onmessage = (event) => { clearTimeout(timer); try { resolve(JSON.parse(event.data) as Record<string, unknown>); } catch { reject(new Error('Invalid pairing response.')); } };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Pairing connection failed.')); };
    });
    socket.send(JSON.stringify({ kind: 'pair', ...pairFields, clientPublicKey: b64(pair.publicKey), deviceName: name.slice(0, 80) }));
    const frame = await response;
    const hostKey = serverPublicKey ?? (typeof frame.serverPublicKey === 'string' ? frame.serverPublicKey : '');
    if (!hostKey) throw new Error('Pairing response carried no host key.');
    const paired = decryptPayload<{ deviceId: string; deviceToken: string; scopes: HostCredential['scopes'] }>(
      { nonce: String(frame.nonce), ciphertext: String(frame.ciphertext) },
      fromB64(hostKey), pair.secretKey,
    );
    socket.close(1000, 'paired');
    if (!paired?.deviceId || !paired.deviceToken) throw new Error('Pairing response could not be authenticated.');
    const credential: HostCredential = {
      id: paired.deviceId, name: name.trim() || 'BrainRouter Desktop', endpoints,
      serverPublicKey: hostKey, clientPublicKey: b64(pair.publicKey), clientSecretKey: b64(pair.secretKey),
      deviceId: paired.deviceId, deviceToken: paired.deviceToken, scopes: paired.scopes,
      counter: 0, pairedAt: new Date().toISOString(),
    };
    await this.store.put(credential);
    return credential;
  }

  /** Manual-QR pairing (scan/paste a pairing code). */
  async pair(rawPayload: string | PairingPayload, name: string): Promise<HostCredential> {
    const pairing = typeof rawPayload === 'string' ? parsePairingPayload(rawPayload) : parsePairingPayload(JSON.stringify(rawPayload));
    return this.runPairing(pairing.endpoints, pairing.serverPublicKey, { pairingToken: pairing.pairingToken }, name);
  }

  /** Account-based pairing (no QR): the desktop was discovered via the account's
   * device list; prove same-account with the account token instead of a QR token. */
  async pairViaAccount(input: { endpoints: string[]; serverPublicKey: string; accountToken: string }, name: string): Promise<HostCredential> {
    // The account token is a long-lived credential: allow cleartext ws: only on a
    // private LAN (same as QR pairing); any public host must use wss: so the token
    // never crosses the internet in the clear (CWE-319).
    const endpoints = input.endpoints.filter((endpoint) => {
      try {
        const url = new URL(endpoint);
        if (url.protocol === 'wss:') return true;
        return url.protocol === 'ws:' && privateHost(url.hostname);
      } catch { return false; }
    });
    if (!endpoints.length) throw new Error('This desktop has no reachable, secure relay endpoint.');
    if (!input.serverPublicKey || !input.accountToken) throw new Error('Missing desktop key or account token.');
    return this.runPairing(endpoints, input.serverPublicKey, { accountToken: input.accountToken }, name);
  }

  async connect(hostId: string): Promise<void> {
    this.intentionalClose = false;
    const credential = await this.store.get(hostId);
    if (!credential) throw new Error('Paired host not found.');
    this.credential = credential;
    this.emit({ type: 'connection', state: 'connecting' });
    const socket = await this.openFirst(credential.endpoints);
    this.socket = socket;
    this.lastServerCounter = 0;
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onclose = () => this.onClose();
    socket.onerror = () => this.emit({ type: 'connection', state: 'disconnected', error: 'WebSocket error' });
    await this.sendAuth();
    this.reconnectAttempt = 0;
    this.emit({ type: 'connection', state: 'connected' });
  }

  close(): void {
    this.intentionalClose = true;
    this.socket?.close(1000, 'closed by user');
    this.socket = undefined;
  }

  async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = `rpc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out.`)); }, 12_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    });
    await this.sendBox({ type: 'rpc', id, method, params });
    return result;
  }

  async acquireFloor(candidateId: string): Promise<boolean> {
    const result = await this.rpc<{ acquired: boolean }>('floor.acquire', { candidateId });
    return result.acquired;
  }
  async subscribeTerminal(candidateId: string): Promise<void> { await this.rpc('terminal.subscribe', { candidateId }); }
  async sendTerminal(candidateId: string, data: string): Promise<void> { await this.rpc('terminal.input', { candidateId, data }); }
  async control(candidateId: string, action: 'followup' | 'interrupt' | 'approve', text?: string): Promise<void> {
    await this.rpc(`agent.${action}`, { candidateId, ...(text ? { text } : {}) });
  }

  private async sendAuth(): Promise<void> {
    if (!this.credential) throw new Error('No credential.');
    const response = new Promise<void>((resolve, reject) => {
      const id = '__auth__';
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Authentication timed out.')); }, 8_000);
      this.pending.set(id, { resolve: () => resolve(), reject, timer });
    });
    await this.sendBox({ type: 'auth', token: this.credential.deviceToken });
    await response;
  }

  private async sendBox(payload: Record<string, unknown>): Promise<void> {
    if (!this.socket || !this.credential || this.socket.readyState !== 1) throw new Error('Host is not connected.');
    const counter = ++this.credential.counter;
    await this.store.put(this.credential);
    const encrypted = encryptPayload({ ...payload, counter }, fromB64(this.credential.serverPublicKey), fromB64(this.credential.clientSecretKey));
    this.socket.send(JSON.stringify({ kind: 'box', deviceId: this.credential.deviceId, ...encrypted }));
  }

  private onMessage(raw: string): void {
    if (!this.credential) return;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    const message = decryptPayload<Record<string, unknown>>(
      { nonce: String(frame.nonce), ciphertext: String(frame.ciphertext) },
      fromB64(this.credential.serverPublicKey), fromB64(this.credential.clientSecretKey),
    );
    const counter = Number(message?.counter);
    if (!message || !Number.isSafeInteger(counter) || counter <= this.lastServerCounter) { this.socket?.close(1008, 'server replay'); return; }
    this.lastServerCounter = counter;
    if (message.type === 'auth.ok') {
      const auth = this.pending.get('__auth__');
      if (auth) { clearTimeout(auth.timer); this.pending.delete('__auth__'); auth.resolve(undefined); }
      return;
    }
    if (message.type === 'rpc.result' || message.type === 'rpc.error') {
      const id = String(message.id ?? '');
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(id);
      if (message.type === 'rpc.error') pending.reject(new Error(String(message.error ?? 'RPC failed.')));
      else pending.resolve(message.result);
      return;
    }
    if (message.type === 'event') this.emit(message as RelayEvent);
  }

  private onClose(): void {
    this.emit({ type: 'connection', state: 'disconnected' });
    if (this.intentionalClose || !this.credential) return;
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++);
    setTimeout(() => { if (!this.intentionalClose && this.credential) void this.connect(this.credential.id).catch(() => {}); }, delay);
  }

  private async openFirst(endpoints: string[]): Promise<SocketLike> {
    let lastError: Error | undefined;
    for (const endpoint of endpoints) {
      try {
        const socket = this.socketFactory(endpoint);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Connection timed out: ${endpoint}`)), 4_000);
          socket.onopen = () => { clearTimeout(timer); resolve(); };
          socket.onerror = () => { clearTimeout(timer); reject(new Error(`Could not connect: ${endpoint}`)); };
        });
        return socket;
      } catch (error) { lastError = error as Error; }
    }
    throw lastError ?? new Error('No relay endpoint is reachable.');
  }

  private emit(event: Parameters<Listener>[0]): void { for (const listener of this.listeners) listener(event); }
}
