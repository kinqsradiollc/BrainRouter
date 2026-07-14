/**
 * Host wiring for the enrolled-device relay client (spec §9, Task 23).
 *
 * - Secrets: a 0600 JSON file under the brainrouter home's mobile/ directory —
 *   the same custody level as the relay NaCl keys beside it (the host is a
 *   utilityProcess, so Electron safeStorage is not reachable here).
 * - Account calls: bearer stays in this process; https-or-loopback plus
 *   redirect:'error' guard (CWE-601/319), matching verifyAccountPeer.
 * - Broker sockets: handed to MobileRelayServer.attachBrokerSocket so the
 *   existing E2EE pairing + scoped RPC allowlist govern remote frames.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { getBrainrouterHome } from '@kinqs/brainrouter-core/storage';
import { loadConfig } from '@kinqs/brainrouter-core/config';
import { resolveBrainRouterAccountApi } from '../accountIntegration.js';
import {
  RemoteAccessClient,
  type BrokerSocketLike,
  type RemoteAccountFetch,
  type RemoteSecretsPort,
} from '../remoteAccessClient.js';
import type { MobileRelayServer } from './mobileRelayServer.js';

function fileSecrets(file: string): RemoteSecretsPort {
  const read = (): Record<string, string> => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>; } catch { return {}; }
  };
  const write = (map: Record<string, string>): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(map)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
  };
  return {
    get: (key) => read()[key] ?? null,
    set: (key, value) => { const map = read(); map[key] = value; write(map); },
    delete: (key) => { const map = read(); delete map[key]; write(map); },
  };
}

/** Authenticated account-API fetch; the bearer never leaves this process. */
const remoteAccountFetch: RemoteAccountFetch = async (apiPath, init) => {
  const api = resolveBrainRouterAccountApi(loadConfig());
  if (!api?.baseUrl || !api.apiKey) return null;
  const base = api.baseUrl.replace(/\/+$/, '');
  let u: URL; try { u = new URL(base); } catch { return null; }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
  try {
    const res = await fetch(`${base}${apiPath}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${api.apiKey}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init?.body ? { body: init.body } : {}),
      redirect: 'error',
    });
    return { ok: res.ok, status: res.status, json: () => res.json() };
  } catch {
    return null;
  }
};

/** Broker URL knob: `cli.remote.relayUrl` in config.json (wss://…), never env. */
function relayUrlFromConfig(): string | null {
  const config = loadConfig() as { cli?: { remote?: { relayUrl?: unknown } } };
  const raw = config.cli?.remote?.relayUrl;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
    // Ticket material must not cross the network in cleartext (CWE-319).
    if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && loopback)) return null;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function createRemoteAccessClient(mobileRelay: MobileRelayServer, home = getBrainrouterHome()): RemoteAccessClient {
  return new RemoteAccessClient({
    accountFetch: remoteAccountFetch,
    secrets: fileSecrets(path.join(home, 'mobile', 'remote-device.json')),
    relayUrl: relayUrlFromConfig,
    attachLocal: (socket, scopes) => mobileRelay.attachBrokerSocket(
      socket as unknown as WebSocket,
      { scopes: scopes.filter((scope): scope is 'monitor' | 'control' | 'approve' => ['monitor', 'control', 'approve'].includes(scope)) },
    ),
    wsFactory: (url) => new WebSocket(url) as unknown as BrokerSocketLike,
  });
}
