import fs from 'node:fs';
import path from 'node:path';
import { getCliKnobs } from '../config/config.js';
import { getStateDir } from '../storage/store.js';

export interface RuntimePreviewPort {
  runtimeId: string;
  name: string;
  port: number;
  host: string;
  protocol: 'http' | 'https';
  url: string;
  registeredAt: string;
  updatedAt: string;
}

export interface RuntimePreviewReservation {
  name: string;
  port: number;
  url: string;
}

export interface RegisterRuntimePreviewInput {
  runtimeId: string;
  name: string;
  port?: number;
  host?: string;
  protocol?: 'http' | 'https';
  now?: string;
}

function previewsPath(workspaceRoot: string): string {
  return path.join(getStateDir(workspaceRoot), 'runtime', 'previews.json');
}

function sanitizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizePort(value: unknown): number {
  const port = typeof value === 'number' && Number.isInteger(value) ? value : NaN;
  if (!Number.isFinite(port) || port < 1 || port > 65_535) throw new Error('preview_port_invalid');
  return port;
}

// App previews are LOCAL-only by design — a preview surfaces a dev server the
// agent started inside its runtime, for the developer at this machine. Any
// non-loopback host (0.0.0.0, a LAN/public IP, an external name) would expose
// that server on the network, so we clamp every registration to loopback.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);
function normalizeLoopbackHost(host: string | undefined): string {
  const trimmed = (host ?? '').trim();
  if (!trimmed) return '127.0.0.1';
  return LOOPBACK_HOSTS.has(trimmed.toLowerCase()) ? trimmed : '127.0.0.1';
}

function previewUrl(protocol: 'http' | 'https', host: string, port: number): string {
  const hostname = host.trim() || '127.0.0.1';
  return `${protocol}://${hostname}:${port}`;
}

function readAll(workspaceRoot: string): RuntimePreviewPort[] {
  try {
    const raw = JSON.parse(fs.readFileSync(previewsPath(workspaceRoot), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is RuntimePreviewPort => (
      entry && typeof entry === 'object' &&
      typeof (entry as RuntimePreviewPort).runtimeId === 'string' &&
      typeof (entry as RuntimePreviewPort).name === 'string' &&
      typeof (entry as RuntimePreviewPort).port === 'number' &&
      typeof (entry as RuntimePreviewPort).url === 'string'
    ));
  } catch {
    return [];
  }
}

function writeAll(workspaceRoot: string, records: RuntimePreviewPort[]): void {
  const file = previewsPath(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(records, null, 2) + '\n', 'utf8');
}

export function resolveRuntimePreviewReservations(): RuntimePreviewReservation[] {
  const configured = getCliKnobs().runtime.previewPorts;
  return Object.entries(configured)
    .map(([name, port]) => ({
      name,
      port,
      url: previewUrl('http', '127.0.0.1', port),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listRuntimePreviewPorts(workspaceRoot: string, runtimeId?: string): RuntimePreviewPort[] {
  const id = runtimeId?.trim();
  return readAll(workspaceRoot)
    .filter((record) => !id || record.runtimeId === id)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function registerRuntimePreviewPort(workspaceRoot: string, input: RegisterRuntimePreviewInput): RuntimePreviewPort {
  const runtimeId = input.runtimeId.trim();
  const name = sanitizeName(input.name);
  if (!runtimeId) throw new Error('runtime_id_required');
  if (!name) throw new Error('preview_name_required');
  const reservations = getCliKnobs().runtime.previewPorts;
  const port = input.port === undefined ? reservations[name] : input.port;
  const normalizedPort = normalizePort(port);
  const host = normalizeLoopbackHost(input.host);
  const protocol = input.protocol ?? 'http';
  const now = input.now ?? new Date().toISOString();
  const records = readAll(workspaceRoot);
  const existing = records.findIndex((record) => record.runtimeId === runtimeId && record.name === name);
  const record: RuntimePreviewPort = {
    runtimeId,
    name,
    port: normalizedPort,
    host,
    protocol,
    url: previewUrl(protocol, host, normalizedPort),
    registeredAt: existing >= 0 ? records[existing].registeredAt : now,
    updatedAt: now,
  };
  if (existing >= 0) records[existing] = record;
  else records.push(record);
  writeAll(workspaceRoot, records);
  return record;
}

export function removeRuntimePreviewPort(workspaceRoot: string, runtimeId: string, name: string): boolean {
  const normalizedName = sanitizeName(name);
  const before = readAll(workspaceRoot);
  const after = before.filter((record) => !(record.runtimeId === runtimeId.trim() && record.name === normalizedName));
  if (after.length === before.length) return false;
  writeAll(workspaceRoot, after);
  return true;
}
