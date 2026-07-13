export type MobileScope = 'monitor' | 'control' | 'approve';

export interface PairingPayload {
  version: 1;
  endpoints: string[];
  serverPublicKey: string;
  pairingToken: string;
  expiresAt: string;
}

export interface HostCredential {
  id: string;
  name: string;
  endpoints: string[];
  serverPublicKey: string;
  clientPublicKey: string;
  clientSecretKey: string;
  deviceId: string;
  deviceToken: string;
  scopes: MobileScope[];
  counter: number;
  pairedAt: string;
}

export interface RelayEvent { type: 'event'; event: string; [key: string]: unknown }

function privateHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  const p = hostname.split('.').map(Number);
  return p.length === 4 && (p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127));
}

export function parsePairingPayload(raw: string): PairingPayload {
  const value = JSON.parse(raw) as Partial<PairingPayload>;
  if (value.version !== 1 || !Array.isArray(value.endpoints) || !value.endpoints.length || typeof value.serverPublicKey !== 'string' || typeof value.pairingToken !== 'string') {
    throw new Error('This is not a BrainRouter pairing code.');
  }
  const endpoints = value.endpoints.filter((endpoint) => {
    try { const url = new URL(endpoint); return (url.protocol === 'ws:' || url.protocol === 'wss:') && privateHost(url.hostname); } catch { return false; }
  });
  if (!endpoints.length) throw new Error('Pairing code has no private-network endpoint.');
  if (!value.expiresAt || Date.parse(value.expiresAt) <= Date.now()) throw new Error('Pairing code expired.');
  return { version: 1, endpoints, serverPublicKey: value.serverPublicKey, pairingToken: value.pairingToken, expiresAt: value.expiresAt };
}
