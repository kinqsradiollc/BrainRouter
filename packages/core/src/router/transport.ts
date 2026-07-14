import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type UpstreamNetworkMode = 'hosted' | 'self-hosted';

export interface ResolvedUpstreamAddress {
  address: string;
  family: 4 | 6;
}

export type UpstreamDnsResolver = (
  hostname: string,
) => Promise<readonly ResolvedUpstreamAddress[]>;

export interface UpstreamTargetPolicy {
  /** Hosted is the fail-closed default. */
  mode?: UpstreamNetworkMode;
  /** Exact origins only. Overrides are honored only in self-hosted mode. */
  allowlist?: readonly string[];
  /** Injectable so callers can test without touching external DNS. */
  resolve?: UpstreamDnsResolver;
}

export interface ValidatedUpstreamTarget {
  url: URL;
  hostname: string;
  addresses: readonly ResolvedUpstreamAddress[];
  allowlisted: boolean;
}

export class UpstreamPolicyError extends Error {
  readonly code = 'UPSTREAM_POLICY_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'UpstreamPolicyError';
  }
}

type AddressClass =
  | 'cloud metadata'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'multicast'
  | 'reserved';

const METADATA_HOSTS = new Set([
  'instance-data.ec2.internal',
  'metadata.azure.internal',
  'metadata.google.internal',
  'metadata.google',
]);

const METADATA_IPV4 = new Set([
  '100.100.100.200',
  '169.254.169.254',
  '169.254.170.2',
]);

function canonicalHostname(raw: string): string {
  const unbracketed = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (unbracketed.includes('%')) {
    throw new UpstreamPolicyError('Scoped IP addresses are not valid upstream targets.');
  }
  const ipFamily = isIP(unbracketed);
  if (ipFamily !== 0) return unbracketed.toLowerCase();

  const hostname = unbracketed.toLowerCase().replace(/\.+$/, '');
  if (!hostname || hostname.includes('*')) {
    throw new UpstreamPolicyError('Upstream targets require an exact hostname.');
  }
  return hostname;
}

function normalizeUrl(input: string | URL): { url: URL; hostname: string } {
  let url: URL;
  try {
    url = new URL(input instanceof URL ? input.href : String(input).trim());
  } catch {
    throw new UpstreamPolicyError('Upstream target is not a valid URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UpstreamPolicyError('Upstream target must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new UpstreamPolicyError('Credentials are not allowed in an upstream URL.');
  }

  const hostname = canonicalHostname(url.hostname);
  if (isIP(hostname) === 0) url.hostname = hostname;
  url.hash = '';
  return { url, hostname };
}

function normalizeAllowlist(entries: readonly string[], mode: UpstreamNetworkMode): ReadonlySet<string> {
  if (mode === 'hosted' && entries.length > 0) {
    throw new UpstreamPolicyError('Upstream allowlist overrides are unavailable in hosted mode.');
  }

  const origins = new Set<string>();
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(String(entry).trim());
    } catch {
      throw new UpstreamPolicyError('A self-hosted allowlist entry must be an exact origin.');
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new UpstreamPolicyError('A self-hosted allowlist entry must be an exact origin without a path, query, or fragment.');
    }
    let normalized: ReturnType<typeof normalizeUrl>;
    try {
      normalized = normalizeUrl(parsed);
    } catch {
      throw new UpstreamPolicyError('A self-hosted allowlist entry must be an exact origin.');
    }
    origins.add(normalized.url.origin);
  }
  return origins;
}

function ipv4Number(address: string): number {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new UpstreamPolicyError(`DNS returned an invalid IP address: ${address}`);
  }
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function ipv4In(value: number, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (ipv4Number(base) & mask);
}

function classifyIpv4(address: string): AddressClass | null {
  if (METADATA_IPV4.has(address)) return 'cloud metadata';
  const value = ipv4Number(address);
  if (ipv4In(value, '127.0.0.0', 8)) return 'loopback';
  if (
    ipv4In(value, '10.0.0.0', 8)
    || ipv4In(value, '100.64.0.0', 10)
    || ipv4In(value, '172.16.0.0', 12)
    || ipv4In(value, '192.168.0.0', 16)
  ) return 'private';
  if (ipv4In(value, '169.254.0.0', 16)) return 'link-local';
  if (ipv4In(value, '224.0.0.0', 4)) return 'multicast';
  if (
    ipv4In(value, '0.0.0.0', 8)
    || ipv4In(value, '192.0.0.0', 24)
    || ipv4In(value, '192.0.2.0', 24)
    || ipv4In(value, '192.88.99.0', 24)
    || ipv4In(value, '198.18.0.0', 15)
    || ipv4In(value, '198.51.100.0', 24)
    || ipv4In(value, '203.0.113.0', 24)
    || ipv4In(value, '240.0.0.0', 4)
  ) return 'reserved';
  return null;
}

function ipv6Number(address: string): bigint {
  let value = address.toLowerCase();
  if (value.includes('%')) throw new UpstreamPolicyError(`DNS returned a scoped IP address: ${address}`);

  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    if (lastColon < 0) throw new UpstreamPolicyError(`DNS returned an invalid IP address: ${address}`);
    const ipv4 = ipv4Number(value.slice(lastColon + 1));
    value = `${value.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) throw new UpstreamPolicyError(`DNS returned an invalid IP address: ${address}`);
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    throw new UpstreamPolicyError(`DNS returned an invalid IP address: ${address}`);
  }
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) {
    throw new UpstreamPolicyError(`DNS returned an invalid IP address: ${address}`);
  }
  return words.reduce((result, word) => (result << 16n) | BigInt(`0x${word}`), 0n);
}

function ipv6In(value: bigint, base: string, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (ipv6Number(base) >> shift);
}

function classifyIpv6(address: string): AddressClass | null {
  const value = ipv6Number(address);
  if (value === ipv6Number('fd00:ec2::254') || value === ipv6Number('fd20:ce::254')) {
    return 'cloud metadata';
  }
  if ((value >> 32n) === 0xffffn) {
    const ipv4 = Number(value & 0xffffffffn);
    const dotted = `${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`;
    return classifyIpv4(dotted);
  }
  if (value === 1n) return 'loopback';
  if (ipv6In(value, 'fc00::', 7)) return 'private';
  if (ipv6In(value, 'fe80::', 10)) return 'link-local';
  if (ipv6In(value, 'ff00::', 8)) return 'multicast';
  if (
    value === 0n
    || ipv6In(value, '100::', 64)
    || ipv6In(value, '2001::', 23)
    || ipv6In(value, '2001:db8::', 32)
    || ipv6In(value, '2002::', 16)
    || ipv6In(value, '3ffe::', 16)
    || !ipv6In(value, '2000::', 3)
  ) return 'reserved';
  return null;
}

function classifyAddress(address: string): { address: ResolvedUpstreamAddress; kind: AddressClass | null } {
  if (address.includes('%')) throw new UpstreamPolicyError(`DNS returned a scoped IP address: ${address}`);
  const family = isIP(address);
  if (family === 4) return { address: { address, family: 4 }, kind: classifyIpv4(address) };
  if (family === 6) return { address: { address: address.toLowerCase(), family: 6 }, kind: classifyIpv6(address) };
  throw new UpstreamPolicyError(`DNS returned an invalid IP address: ${address}`);
}

function hostnameClass(hostname: string): AddressClass | null {
  if (METADATA_HOSTS.has(hostname) || hostname.endsWith('.metadata.google.internal')) return 'cloud metadata';
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return 'loopback';
  return null;
}

const defaultResolver: UpstreamDnsResolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

/**
 * Resolve and validate a target once, returning the exact addresses that the
 * caller must pin into its network dispatcher. Every DNS answer is checked;
 * one unsafe answer rejects the whole target.
 */
export async function validateUpstreamTarget(
  input: string | URL,
  policy: UpstreamTargetPolicy = {},
): Promise<ValidatedUpstreamTarget> {
  const mode = policy.mode ?? 'hosted';
  const { url, hostname } = normalizeUrl(input);
  const allowlist = normalizeAllowlist(policy.allowlist ?? [], mode);
  const allowlisted = mode === 'self-hosted' && allowlist.has(url.origin);

  if (url.protocol !== 'https:' && !allowlisted) {
    throw new UpstreamPolicyError('HTTP upstreams require an exact self-hosted origin allowlist.');
  }

  const hostKind = hostnameClass(hostname);
  if (hostKind === 'cloud metadata') {
    throw new UpstreamPolicyError('Cloud metadata targets are never valid upstreams.');
  }
  if (hostKind && !allowlisted) {
    throw new UpstreamPolicyError(`Upstream hostname resolves to a ${hostKind} target and requires an exact self-hosted allowlist.`);
  }

  const directFamily = isIP(hostname);
  const rawAnswers = directFamily
    ? [{ address: hostname, family: directFamily as 4 | 6 }]
    : await (policy.resolve ?? defaultResolver)(hostname);
  if (rawAnswers.length === 0) {
    throw new UpstreamPolicyError('Upstream hostname did not resolve to an address.');
  }

  const seen = new Set<string>();
  const addresses: ResolvedUpstreamAddress[] = [];
  for (const raw of rawAnswers) {
    const classified = classifyAddress(raw.address);
    const kind = classified.kind;
    if (kind === 'cloud metadata' || kind === 'multicast' || kind === 'reserved') {
      throw new UpstreamPolicyError(`Upstream address ${raw.address} is ${kind} and is not permitted.`);
    }
    if (kind && !allowlisted) {
      throw new UpstreamPolicyError(`Upstream address ${raw.address} is ${kind} and requires an exact self-hosted allowlist.`);
    }
    const key = `${classified.address.family}:${classified.address.address}`;
    if (!seen.has(key)) {
      seen.add(key);
      addresses.push(Object.freeze(classified.address));
    }
  }

  return Object.freeze({
    url,
    hostname,
    addresses: Object.freeze(addresses),
    allowlisted,
  });
}

export type PinnedLookupResult = string | readonly ResolvedUpstreamAddress[] | undefined;
export type PinnedLookupCallback = (
  error: NodeJS.ErrnoException | null,
  result: PinnedLookupResult,
  family?: number,
) => void;
export type PinnedLookup = (
  hostname: string,
  options: number | { family?: number; all?: boolean },
  callback: PinnedLookupCallback,
) => void;

function lookupError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'ENOTFOUND';
  return error;
}

/** A DNS lookup callback that can only return the already-validated addresses. */
export function createPinnedLookup(target: ValidatedUpstreamTarget): PinnedLookup {
  return (hostname, options, callback) => {
    queueMicrotask(() => {
      let requested: string;
      try {
        requested = canonicalHostname(hostname);
      } catch (error) {
        callback(error as NodeJS.ErrnoException, undefined);
        return;
      }
      if (requested !== target.hostname) {
        callback(lookupError('Pinned lookup hostname mismatch.'), undefined);
        return;
      }

      const requestedFamily = typeof options === 'number' ? options : options.family;
      const candidates = requestedFamily === 4 || requestedFamily === 6
        ? target.addresses.filter((entry) => entry.family === requestedFamily)
        : target.addresses;
      if (candidates.length === 0) {
        callback(lookupError('Pinned lookup has no validated address for the requested family.'), undefined);
        return;
      }
      if (typeof options !== 'number' && options.all) {
        callback(null, candidates);
        return;
      }
      callback(null, candidates[0]!.address, candidates[0]!.family);
    });
  };
}
