/**
 * ADR-043 S3b (C5b) — the SSRF guard for the edge dial handler. The device dials
 * a host:port that the SERVER named (the gateway already validated it against its
 * own upstream allowlist), but the device runs on the USER'S network, so a dial
 * is a pivot into that network if the instruction is ever tampered with or the
 * server is compromised. This guard is defense-in-depth: before the device opens
 * ANY socket it (1) optionally checks the host against an allowlist predicate,
 * (2) resolves the hostname, (3) refuses if the literal or ANY resolved address
 * falls in a loopback / private / link-local / metadata / ULA / multicast /
 * reserved range, and (4) pins the connection to a vetted address so a later
 * re-resolution cannot rebind to a blocked IP.
 *
 * Fails closed: an unparseable IP, a host that does not resolve, or a mixed
 * public+private DNS record all reject.
 */
import { isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';

export class DialNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DialNotAllowedError';
  }
}

export interface DialGuardOptions {
  /** DNS resolver returning ALL addresses; injected for tests. Defaults to dns/promises lookup(all). */
  lookup?: (host: string) => Promise<LookupAddress[]>;
  /** Optional host allowlist predicate (checked before any resolution). */
  isHostAllowed?: (host: string) => boolean;
}

/**
 * The concrete, vetted endpoint to connect to — PINNED. Carries only the
 * resolved IP (`address`), never the hostname: the device does not terminate TLS
 * (the server does), so it needs no SNI, and exposing the hostname would invite a
 * dialer to `net.connect({host})` and re-resolve, defeating the resolve-and-pin
 * guard (TOCTOU rebind). The dialer MUST connect to `address:port`.
 */
export interface VettedTarget {
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: number;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    n = (n << 8) | value;
  }
  return n >>> 0;
}

function inCidr4(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this host"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. 169.254.169.254 cloud metadata)
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved (incl. 255.255.255.255 broadcast)
];

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → fail closed
  return BLOCKED_V4.some(([base, bits]) => inCidr4(n, base, bits));
}

/** Parse a textual IPv6 (incl. `::`, embedded IPv4, zone id) to 16 bytes, or null. */
function ipv6ToBytes(input: string): Uint8Array | null {
  const addr = input.split('%')[0].toLowerCase(); // drop any zone id
  let head = addr;
  // An embedded dotted-quad tail (::ffff:1.2.3.4 or 64:ff9b::1.2.3.4) → two hextets.
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    head = `${addr.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const toGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const groups = segment.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];
  if (left === null || right === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null; // :: must stand for at least one zero group
    groups = [...left, ...Array<number>(missing).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    bytes[i * 2] = (groups[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

function allZero(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) if (bytes[i] !== 0) return false;
  return true;
}

function embeddedV4(b: Uint8Array): string {
  return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
}

function isBlockedIpv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (b === null) return true; // unparseable → fail closed
  // IPv4-mapped (::ffff:0:0/96) → judge by the embedded IPv4.
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIpv4(embeddedV4(b));
  // NAT64 well-known prefix 64:ff9b::/96 → embedded IPv4.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12)) {
    return isBlockedIpv4(embeddedV4(b));
  }
  // ::/96 covers the unspecified (::), loopback (::1), AND the deprecated
  // IPv4-COMPATIBLE form ::a.b.c.d — all judged by the embedded IPv4 (0.0.0.0/8
  // catches :: and ::1; a compatible ::127.0.0.1 / ::169.254.169.254 is caught
  // by the loopback/link-local IPv4 blocks). This closes the ::a.b.c.d bypass.
  if (allZero(b, 0, 12)) return isBlockedIpv4(embeddedV4(b));
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 2002::/16 6to4 (deprecated; can wrap an internal IPv4)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 doc
  return false;
}

function isBlockedIp(ip: string, family: number): boolean {
  return family === 6 ? isBlockedIpv6(ip) : isBlockedIpv4(ip);
}

/**
 * Vet a server-named dial target and return the pinned address to connect to.
 * Throws {@link DialNotAllowedError} if it must be refused.
 */
export async function vetDialTarget(host: string, port: number, opts: DialGuardOptions = {}): Promise<VettedTarget> {
  if (typeof host !== 'string' || host.length === 0) throw new DialNotAllowedError('missing host');
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new DialNotAllowedError('invalid port');
  if (opts.isHostAllowed && !opts.isHostAllowed(host)) {
    throw new DialNotAllowedError(`host not allowlisted: ${host}`);
  }

  const literalFamily = isIP(host);
  if (literalFamily) {
    if (isBlockedIp(host, literalFamily)) throw new DialNotAllowedError('target IP is in a blocked range');
    return { address: host, family: literalFamily as 4 | 6, port };
  }

  const lookup =
    opts.lookup ?? (async (h: string) => (await import('node:dns/promises')).lookup(h, { all: true }));
  const addresses = await lookup(host);
  if (!addresses || addresses.length === 0) throw new DialNotAllowedError('host did not resolve');
  // Reject if ANY resolved address is blocked — a record that mixes a public and
  // a private A record must not be dialable via the public one.
  for (const a of addresses) {
    if (isBlockedIp(a.address, a.family)) {
      throw new DialNotAllowedError('host resolves to a blocked range');
    }
  }
  const chosen = addresses[0];
  return { address: chosen.address, family: chosen.family as 4 | 6, port };
}

/** Exposed for tests. */
export const __test = { isBlockedIpv4, isBlockedIpv6, ipv6ToBytes };
