/**
 * ADR-021 (0.4.17) — validates renderer-supplied MCP profile input before it reaches config
 * persistence or the live client pool.
 *
 * The renderer may add remote HTTP profiles only. Local stdio profiles are an
 * operating-system execution capability and must be configured from the trusted
 * CLI instead of crossing the renderer query boundary.
 */
import type { ServerConfig } from '@kinqs/brainrouter-core/config';

const RESERVED_SERVER_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const SERVER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_SERVER_ID_BYTES = 128;
const MAX_API_KEY_BYTES = 16 * 1024;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_NAME_BYTES = 256;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_HEADERS_BYTES = 32 * 1024;

export interface DesktopMcpAddSuccess {
  ok: true;
  id: string;
  config: ServerConfig & { type: 'http'; url: string };
}

export interface DesktopMcpAddFailure {
  ok: false;
  error: string;
}

export type DesktopMcpAddInputResult = DesktopMcpAddSuccess | DesktopMcpAddFailure;

type HeaderParseResult =
  | { ok: true; headers: Record<string, string> }
  | DesktopMcpAddFailure;
type HeaderEntriesResult =
  | { ok: true; entries: readonly (readonly [string, string])[] }
  | DesktopMcpAddFailure;

export function isDesktopMcpServerIdReserved(serverId: string): boolean {
  return RESERVED_SERVER_IDS.has(serverId);
}

function fail(error: string): DesktopMcpAddFailure {
  return { ok: false, error };
}

function headerEntries(raw: unknown): HeaderEntriesResult {
  if (raw == null || raw === '') return { ok: true, entries: [] };

  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > MAX_HEADERS_BYTES) return fail('MCP headers are too large.');
    const lines = raw.split('\n');
    if (lines.length > MAX_HEADER_COUNT + 1) return fail('Too many MCP headers.');
    const entries: Array<readonly [string, string]> = [];
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) continue;
      const separator = line.indexOf('=');
      if (separator <= 0) return fail('Each MCP header must use Header-Name=value.');
      entries.push([line.slice(0, separator), line.slice(separator + 1)]);
    }
    return { ok: true, entries };
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('MCP headers are invalid.');
  const entries = Object.entries(raw);
  if (entries.length > MAX_HEADER_COUNT) return fail('Too many MCP headers.');
  if (entries.some(([, value]) => typeof value !== 'string')) return fail('MCP header values must be text.');
  return { ok: true, entries: entries as Array<[string, string]> };
}

function parseHeaders(raw: unknown): HeaderParseResult {
  const parsedEntries = headerEntries(raw);
  if (!parsedEntries.ok) return parsedEntries;
  const { entries } = parsedEntries;
  if (entries.length > MAX_HEADER_COUNT) return fail('Too many MCP headers.');

  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  const normalizedNames = new Set<string>();
  let totalBytes = 0;

  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    const normalizedName = name.toLowerCase();
    if (
      !name
      || isDesktopMcpServerIdReserved(normalizedName)
      || !HEADER_NAME_PATTERN.test(name)
      || Buffer.byteLength(name) > MAX_HEADER_NAME_BYTES
    ) {
      return fail('An MCP header name is invalid.');
    }
    if (CONTROL_CHARACTER_PATTERN.test(rawValue)) return fail('MCP header values cannot contain control characters.');
    const value = rawValue.trim();
    if (Buffer.byteLength(value) > MAX_HEADER_VALUE_BYTES) return fail('An MCP header value is too large.');
    if (normalizedNames.has(normalizedName)) return fail('MCP header names must be unique.');

    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (totalBytes > MAX_HEADERS_BYTES) return fail('MCP headers are too large.');
    normalizedNames.add(normalizedName);
    headers[name] = value;
  }

  return { ok: true, headers };
}

/** Parse and bound the untrusted renderer payload for `action:add-mcp`. */
export function parseDesktopMcpAddInput(args: Record<string, unknown>): DesktopMcpAddInputResult {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!SERVER_ID_PATTERN.test(id) || Buffer.byteLength(id) > MAX_SERVER_ID_BYTES) {
    return fail('Server id must be 1-128 letters, digits, dash, underscore or dot.');
  }
  if (isDesktopMcpServerIdReserved(id)) return fail(`MCP server id "${id}" is reserved.`);

  if (args.type !== 'http') {
    return fail('Desktop can add remote HTTP MCP servers only. Configure local stdio servers with brainrouter config.');
  }

  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) return fail('An HTTP server needs a URL.');

  const apiKey = args.apiKey == null ? '' : args.apiKey;
  if (typeof apiKey !== 'string') return fail('The MCP API key is invalid.');
  if (CONTROL_CHARACTER_PATTERN.test(apiKey) || Buffer.byteLength(apiKey) > MAX_API_KEY_BYTES) {
    return fail('The MCP API key contains invalid characters or is too large.');
  }

  const parsedHeaders = parseHeaders(args.headers);
  if (!parsedHeaders.ok) return parsedHeaders;
  const { headers } = parsedHeaders;

  const config: ServerConfig & { type: 'http'; url: string } = {
    type: 'http',
    url,
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
  return { ok: true, id, config };
}
