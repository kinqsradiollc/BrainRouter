import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { getBrainrouterHome } from '@kinqs/brainrouter-core/storage';
import { MobileDeviceRegistry, type MobileDeviceRecord, type MobileScope } from './mobileDeviceRegistry.js';
import {
  b64,
  createRelayKeyPair,
  decryptRelayPayload,
  encryptRelayPayload,
  fromB64,
  hashDeviceToken,
  randomToken,
  tokenMatches,
} from './mobileRelayCrypto.js';

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 8 * 1024;
const RATE_PER_MINUTE = 120;
const FLOOR_TTL_MS = 30_000;
const PAIRING_TTL_MS = 5 * 60_000;

type RelayPayload =
  | { type: 'auth'; token: string; counter: number }
  | { type: 'rpc'; id: string; method: string; params?: Record<string, unknown>; counter: number };

type SocketState = {
  device?: MobileDeviceRecord;
  authenticated: boolean;
  serverCounter: number;
  rates: number[];
  subscriptions: Map<string, number>;
  lastStatusAt: number;
  lastStatusHash: string;
  candidateStates: Map<string, string>;
};

const METHOD_SCOPE: Record<string, MobileScope> = {
  'status.list': 'monitor',
  'fanout.list': 'monitor',
  'terminal.snapshot': 'monitor',
  'terminal.subscribe': 'monitor',
  'floor.acquire': 'control',
  'floor.release': 'control',
  'terminal.input': 'control',
  'agent.followup': 'control',
  'agent.interrupt': 'control',
  'agent.approve': 'approve',
};

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127)
  );
}

export function relayAdvertiseHosts(lan: boolean, interfaces = os.networkInterfaces()): string[] {
  if (!lan) return ['127.0.0.1'];
  const tailscale: string[] = [];
  const privateLan: string[] = [];
  for (const rows of Object.values(interfaces)) {
    for (const row of rows ?? []) {
      if (row.internal || row.family !== 'IPv4' || !isPrivateV4(row.address)) continue;
      const parts = row.address.split('.').map(Number);
      if (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) tailscale.push(row.address);
      else privateLan.push(row.address);
    }
  }
  return [...new Set([...tailscale, ...privateLan, '127.0.0.1'])];
}

export class MobileRelayServer {
  private wss?: WebSocketServer;
  private timer?: ReturnType<typeof setInterval>;
  private readonly registry: MobileDeviceRegistry;
  private readonly keys: { publicKey: Uint8Array; secretKey: Uint8Array };
  private readonly sockets = new Map<WebSocket, SocketState>();
  private readonly pairing = new Map<string, { expiresAt: number; scopes: MobileScope[] }>();
  private readonly floor = new Map<string, { deviceId: string; expiresAt: number }>();
  private endpoints: string[] = [];

  constructor(private readonly options: {
    status: () => unknown;
    terminalSnapshot: (candidateId: string) => { snapshot: string; start: number; next: number; alive: boolean } | null;
    terminalInput: (candidateId: string, data: string) => boolean;
    agentControl: (candidateId: string, action: 'follow-up' | 'interrupt' | 'approve', text?: string) => boolean;
    home?: string;
  }) {
    const home = options.home ?? getBrainrouterHome();
    this.registry = new MobileDeviceRegistry(home);
    this.keys = this.loadKeys(home);
  }

  async start(input: { lan?: boolean; port?: number } = {}): Promise<ReturnType<MobileRelayServer['status']>> {
    if (this.wss) return this.status();
    const lan = input.lan === true;
    this.wss = new WebSocketServer({ host: lan ? '0.0.0.0' : '127.0.0.1', port: input.port ?? 0, maxPayload: MAX_FRAME_BYTES });
    this.wss.on('connection', (socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.wss!.once('listening', resolve);
      this.wss!.once('error', reject);
    });
    const address = this.wss.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    this.endpoints = relayAdvertiseHosts(lan).map((host) => `ws://${host}:${port}`);
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref?.();
    return this.status();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const socket of this.sockets.keys()) socket.close(1001, 'relay stopped');
    this.sockets.clear();
    this.wss?.close();
    this.wss = undefined;
    this.endpoints = [];
    this.floor.clear();
    this.pairing.clear();
  }

  status() {
    return {
      running: !!this.wss,
      endpoints: [...this.endpoints],
      connectedDevices: [...this.sockets.values()].filter((state) => state.authenticated).length,
      devices: this.registry.list().map(({ id, name, scopes, createdAt, lastSeenAt }) => ({ id, name, scopes, createdAt, lastSeenAt })),
      publicKey: b64(this.keys.publicKey),
    };
  }

  createPairing(scopes: MobileScope[] = ['monitor', 'control']): { version: 1; endpoints: string[]; serverPublicKey: string; pairingToken: string; expiresAt: string } {
    if (!this.wss) throw new Error('Mobile relay is not running.');
    const clean = [...new Set(scopes.filter((scope): scope is MobileScope => ['monitor', 'control', 'approve'].includes(scope)))];
    const pairingToken = randomToken();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pairing.set(pairingToken, { expiresAt, scopes: clean.length ? clean : ['monitor'] });
    return { version: 1, endpoints: [...this.endpoints], serverPublicKey: b64(this.keys.publicKey), pairingToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  revoke(deviceId: string): boolean {
    for (const [socket, state] of this.sockets) if (state.device?.id === deviceId) socket.close(1008, 'device revoked');
    return this.registry.revoke(deviceId);
  }

  private onConnection(socket: WebSocket): void {
    this.sockets.set(socket, { authenticated: false, serverCounter: 0, rates: [], subscriptions: new Map(), lastStatusAt: 0, lastStatusHash: '', candidateStates: new Map() });
    socket.on('message', (data) => this.onMessage(socket, data));
    socket.on('close', () => {
      const state = this.sockets.get(socket);
      if (state?.device) for (const [resource, lease] of this.floor) if (lease.deviceId === state.device.id) this.floor.delete(resource);
      this.sockets.delete(socket);
    });
    socket.on('error', () => { /* close owns cleanup */ });
  }

  private onMessage(socket: WebSocket, data: RawData): void {
    const state = this.sockets.get(socket);
    if (!state) return;
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (raw.byteLength > MAX_FRAME_BYTES || !this.takeRate(state)) { socket.close(1008, 'policy limit'); return; }
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { socket.close(1003, 'invalid json'); return; }
    if (frame.kind === 'pair') { this.handlePair(socket, frame); return; }
    if (frame.kind !== 'box' || typeof frame.deviceId !== 'string' || typeof frame.nonce !== 'string' || typeof frame.ciphertext !== 'string') {
      socket.close(1008, 'invalid frame'); return;
    }
    const device = this.registry.get(frame.deviceId);
    if (!device || device.revokedAt) { socket.close(1008, 'unknown device'); return; }
    const payload = decryptRelayPayload<RelayPayload>(
      { nonce: frame.nonce, ciphertext: frame.ciphertext },
      fromB64(device.publicKey), this.keys.secretKey,
    );
    if (!payload || !Number.isSafeInteger(payload.counter) || payload.counter <= device.lastCounter) {
      socket.close(1008, 'replay or decrypt failure'); return;
    }
    device.lastCounter = payload.counter;
    device.lastSeenAt = new Date().toISOString();
    this.registry.put(device);
    state.device = device;
    if (payload.type === 'auth') {
      if (!tokenMatches(payload.token, device.tokenHash)) { socket.close(1008, 'authentication failed'); return; }
      state.authenticated = true;
      this.sendEncrypted(socket, { type: 'auth.ok', deviceId: device.id, scopes: device.scopes });
      return;
    }
    if (!state.authenticated || payload.type !== 'rpc') { socket.close(1008, 'authenticate first'); return; }
    void this.handleRpc(socket, payload);
  }

  private handlePair(socket: WebSocket, frame: Record<string, unknown>): void {
    const token = typeof frame.pairingToken === 'string' ? frame.pairingToken : '';
    const pending = this.pairing.get(token);
    const clientPublicKey = typeof frame.clientPublicKey === 'string' ? fromB64(frame.clientPublicKey) : new Uint8Array();
    if (!pending || pending.expiresAt < Date.now() || clientPublicKey.length !== 32) { socket.close(1008, 'invalid pairing'); return; }
    this.pairing.delete(token);
    const deviceToken = randomToken();
    const device: MobileDeviceRecord = {
      id: `device_${randomUUID().slice(0, 12)}`,
      name: typeof frame.deviceName === 'string' ? frame.deviceName.slice(0, 80) : 'Mobile device',
      publicKey: b64(clientPublicKey), tokenHash: hashDeviceToken(deviceToken), scopes: pending.scopes,
      lastCounter: 0, createdAt: new Date().toISOString(),
    };
    this.registry.put(device);
    const encrypted = encryptRelayPayload({ type: 'paired', deviceId: device.id, deviceToken, scopes: device.scopes }, clientPublicKey, this.keys.secretKey);
    socket.send(JSON.stringify({ kind: 'paired', deviceId: device.id, serverPublicKey: b64(this.keys.publicKey), ...encrypted }));
  }

  private async handleRpc(socket: WebSocket, payload: Extract<RelayPayload, { type: 'rpc' }>): Promise<void> {
    const state = this.sockets.get(socket);
    const device = state?.device;
    if (!state || !device) return;
    const required = METHOD_SCOPE[payload.method];
    if (!required || !device.scopes.includes(required)) { this.sendEncrypted(socket, { type: 'rpc.error', id: payload.id, error: 'method-not-allowed' }); return; }
    const params = payload.params ?? {};
    const candidateId = typeof params.candidateId === 'string' ? params.candidateId : '';
    try {
      let result: unknown;
      switch (payload.method) {
        case 'status.list':
        case 'fanout.list': result = this.options.status(); break;
        case 'terminal.snapshot': result = this.options.terminalSnapshot(candidateId); break;
        case 'terminal.subscribe': state.subscriptions.set(candidateId, 0); result = { subscribed: true }; break;
        case 'floor.acquire': result = this.acquireFloor(candidateId, device.id); break;
        case 'floor.release': result = this.releaseFloor(candidateId, device.id); break;
        case 'terminal.input': {
          const data = typeof params.data === 'string' ? params.data : '';
          if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) throw new Error('input-too-large');
          this.requireFloor(candidateId, device.id);
          result = { ok: this.options.terminalInput(candidateId, data) };
          break;
        }
        case 'agent.followup':
        case 'agent.interrupt':
        case 'agent.approve': {
          this.requireFloor(candidateId, device.id);
          const action = payload.method === 'agent.followup' ? 'follow-up' : payload.method === 'agent.interrupt' ? 'interrupt' : 'approve';
          result = { ok: this.options.agentControl(candidateId, action, typeof params.text === 'string' ? params.text : undefined) };
          break;
        }
        default: throw new Error('method-not-allowed');
      }
      this.sendEncrypted(socket, { type: 'rpc.result', id: payload.id, result });
    } catch (error) {
      this.sendEncrypted(socket, { type: 'rpc.error', id: payload.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const [token, pending] of this.pairing) if (pending.expiresAt < now) this.pairing.delete(token);
    for (const [resource, lease] of this.floor) if (lease.expiresAt < now) this.floor.delete(resource);
    for (const [socket, state] of this.sockets) {
      if (!state.authenticated || socket.readyState !== WebSocket.OPEN) continue;
      for (const [candidateId, cursor] of state.subscriptions) {
        const snapshot = this.options.terminalSnapshot(candidateId);
        if (!snapshot) continue;
        const start = Math.max(snapshot.start, Math.min(cursor, snapshot.next));
        const chunk = snapshot.snapshot.slice(start - snapshot.start);
        if (chunk) this.sendEncrypted(socket, { type: 'event', event: 'terminal.output', candidateId, chunk, next: snapshot.next, alive: snapshot.alive });
        state.subscriptions.set(candidateId, snapshot.next);
      }
      if (now - state.lastStatusAt < 2_000) continue;
      state.lastStatusAt = now;
      const status = this.options.status();
      const hash = JSON.stringify(status);
      if (hash === state.lastStatusHash) continue;
      state.lastStatusHash = hash;
      this.sendEncrypted(socket, { type: 'event', event: 'status.changed', status });
      const runs = Array.isArray(status) ? status : [];
      for (const run of runs as Array<{ candidates?: Array<{ id?: string; status?: string }> }>) {
        for (const candidate of run.candidates ?? []) {
          if (!candidate.id || !candidate.status) continue;
          const previous = state.candidateStates.get(candidate.id);
          state.candidateStates.set(candidate.id, candidate.status);
          if (previous && previous !== candidate.status && ['done', 'failed'].includes(candidate.status)) {
            this.sendEncrypted(socket, { type: 'event', event: 'agent.completed', candidateId: candidate.id, status: candidate.status });
          }
        }
      }
    }
  }

  private sendEncrypted(socket: WebSocket, payload: unknown): void {
    const state = this.sockets.get(socket);
    if (!state?.device || socket.readyState !== WebSocket.OPEN) return;
    const counter = ++state.serverCounter;
    const encrypted = encryptRelayPayload({ ...payload as object, counter }, fromB64(state.device.publicKey), this.keys.secretKey);
    socket.send(JSON.stringify({ kind: 'box', deviceId: state.device.id, counter, ...encrypted }));
  }

  private takeRate(state: SocketState): boolean {
    const cutoff = Date.now() - 60_000;
    state.rates = state.rates.filter((at) => at >= cutoff);
    if (state.rates.length >= RATE_PER_MINUTE) return false;
    state.rates.push(Date.now());
    return true;
  }

  private acquireFloor(resource: string, deviceId: string): { acquired: boolean; expiresAt?: string } {
    if (!resource) throw new Error('candidate-required');
    const current = this.floor.get(resource);
    if (current && current.deviceId !== deviceId && current.expiresAt > Date.now()) return { acquired: false };
    const expiresAt = Date.now() + FLOOR_TTL_MS;
    this.floor.set(resource, { deviceId, expiresAt });
    return { acquired: true, expiresAt: new Date(expiresAt).toISOString() };
  }

  private releaseFloor(resource: string, deviceId: string): { released: boolean } {
    const current = this.floor.get(resource);
    if (!current || current.deviceId !== deviceId) return { released: false };
    this.floor.delete(resource);
    return { released: true };
  }

  private requireFloor(resource: string, deviceId: string): void {
    const current = this.floor.get(resource);
    if (!current || current.deviceId !== deviceId || current.expiresAt < Date.now()) throw new Error('terminal-floor-required');
    current.expiresAt = Date.now() + FLOOR_TTL_MS;
  }

  private loadKeys(home: string): { publicKey: Uint8Array; secretKey: Uint8Array } {
    const file = path.join(home, 'mobile', 'desktop-key.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { publicKey: string; secretKey: string };
      const publicKey = fromB64(parsed.publicKey);
      const secretKey = fromB64(parsed.secretKey);
      if (publicKey.length === 32 && secretKey.length === 32) return { publicKey, secretKey };
    } catch { /* generate */ }
    const pair = createRelayKeyPair();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ publicKey: b64(pair.publicKey), secretKey: b64(pair.secretKey) })}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
    return pair;
  }
}
