/**
 * One guarded outbound fetch, for every feature that reaches a URL a person typed.
 *
 * This began inside `websearch/crawler.ts`, where the agent's `fetch_url` needed
 * it. ADR-029 F3 adds two more callers — a bookmark's preview and an image
 * pasted as an address — and a second copy of an SSRF guard is the shape of
 * defect this repository has already paid for once: the copies drift, one of
 * them forgets a range, and the one that forgot is the one an attacker finds.
 *
 * So the guard moved here and the crawler calls it. What it enforces, on EVERY
 * redirect hop rather than only on the first URL:
 *
 *  - the scheme is http or https, and there are no credentials in the URL;
 *  - the host does not resolve to a loopback, private, CGNAT, link-local or
 *    cloud-metadata address (re-resolved per hop, which is what blunts DNS
 *    rebinding — a name that answered publicly once can answer 169.254.169.254
 *    the second time);
 *  - redirects are capped, so a chain cannot be used as an unbounded crawl;
 *  - the body is capped BEFORE it is read where the server declares a length,
 *    and again after, because a declared length is a claim rather than a fact;
 *  - there is a timeout, so a host that accepts the connection and says nothing
 *    cannot hold a handle open for the life of the process.
 *
 * The SSRF check is skipped when the caller injects `fetchImpl`. That is not a
 * hole: an injected fetch controls its own egress, and leaving the check in
 * would make every test with a fake hostname depend on real DNS.
 */
import dns from 'node:dns';
import net from 'node:net';

/** A chain long enough for the redirects real sites use, short enough to bound. */
export const MAX_GUARDED_REDIRECTS = 5;

/**
 * An IPv6 literal as its eight 16-bit groups, or null when it is not one.
 *
 * Written out rather than pattern-matched on the text, because every prefix test
 * over the SPELLING is wrong for a literal spelled differently: `fe80::1` and
 * `fe80:0:0:0:0:0:0:1` are the same address and only one of them starts with the
 * four characters a `startsWith` looks for. `net.isIPv6` gates the parse, so a
 * long hostile string is rejected before any of this walks it.
 */
function ipv6Groups(literal: string): number[] | null {
  if (!net.isIPv6(literal)) return null;
  let text = literal.toLowerCase();

  // A trailing dotted quad (`::ffff:127.0.0.1`) becomes two hex groups first, so
  // the rest of the parse only ever sees hex. Bounded on both sides: the greedy
  // head is followed by a fixed-width tail, and `net.isIPv6` has already capped
  // the length at a valid literal.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted[2]!.split('.').map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${dotted[1]}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0]!.split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1]!.split(':') : []) : null;
  const groups = tail === null
    ? head
    : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  const out: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group === '' ? '0' : group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    out.push(value);
  }
  return out;
}

function blockedIpv4(value: string): boolean {
  const p = value.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 127) return true;               // unspecified / loopback
  if (a === 10) return true;                            // 10/8 private
  if (a === 172 && b! >= 16 && b! <= 31) return true;    // 172.16/12 private
  if (a === 192 && b === 168) return true;              // 192.168/16 private
  if (a === 169 && b === 254) return true;              // link-local + cloud metadata
  if (a === 100 && b! >= 64 && b! <= 127) return true;   // 100.64/10 CGNAT
  return false;
}

const dottedOf = (high: number, low: number): string =>
  `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;

/**
 * True for any address a user-supplied URL must never reach: loopback, RFC1918
 * private, CGNAT, link-local (including 169.254.169.254 cloud metadata), IPv6
 * loopback/ULA/link-local, and anything unparsable (fail closed).
 *
 * **Brackets are stripped first.** `new URL('http://[::1]/').hostname` keeps
 * them, so every caller of this function is handing it a bracketed literal on
 * the one shape that matters most.
 *
 * **An IPv4 address wearing an IPv6 spelling is still that IPv4 address.** The
 * mapped, compatible, NAT64 and 6to4 embeddings all carry 32 bits of IPv4 inside
 * a v6 literal, and a guard that only knew `::ffff:127.0.0.1` in its dotted form
 * would let `::ffff:7f00:1` — which is what `new URL` normalises that very
 * string to — straight through to loopback.
 */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  if (net.isIPv4(bare)) return blockedIpv4(bare);

  const groups = ipv6Groups(bare);
  if (!groups) return true; // unknown format → fail closed

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  if (groups.every((g) => g === 0)) return true;                       // ::  unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
  if ((g0 & 0xffc0) === 0xfe80) return true;                           // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true;                           // fec0::/10 site-local
  if ((g0 & 0xfe00) === 0xfc00) return true;                           // fc00::/7 ULA

  // The four ways an IPv4 address hides inside a v6 one. Each is decoded and
  // sent back through the v4 rules rather than given a rule of its own, so the
  // two answers cannot drift.
  const embedded = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)
    ? dottedOf(g6, g7)                                                  // ::ffff:a.b.c.d / ::a.b.c.d
    : g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0
      ? dottedOf(g6, g7)                                                // 64:ff9b::/96 NAT64
      : g0 === 0x2002
        ? dottedOf(g1, g2)                                              // 2002::/16 6to4
        : null;
  return embedded === null ? false : blockedIpv4(embedded);
}

/**
 * Resolve `hostname` and return a block reason if it (or any resolved IP) is a
 * non-public address.
 *
 * A DNS failure returns null rather than a refusal: the fetch that follows will
 * fail with a normal network error, and reporting "refused as private" for a
 * name that simply does not exist tells the reader something untrue.
 */
export async function privateAddressReason(hostname: string): Promise<string | null> {
  // The bracketed IPv6 literal is unwrapped BEFORE either question is asked.
  // `net.isIP('[::1]')` is 0, so without this the literal is not an address —
  // and it is not a name DNS can answer either, so it fell through the lookup's
  // `catch` and was reported as public. That is an SSRF, and it is the whole
  // reason this line exists.
  const literal = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (net.isIP(literal)) {
    return isBlockedAddress(literal) ? `Refusing to fetch a non-public address (${literal}).` : null;
  }
  let records: Array<{ address: string }>;
  try {
    records = await dns.promises.lookup(hostname, { all: true });
  } catch {
    return null;
  }
  const bad = records.find((r) => isBlockedAddress(r.address));
  return bad ? `Refusing to fetch ${hostname} — it resolves to a non-public address (${bad.address}).` : null;
}

export type GuardedFetchReason = 'network' | 'timeout' | 'oversized' | 'http-status';

export interface GuardedFetchOptions {
  timeoutMs: number;
  /** Hard cap on the body actually read into memory. */
  maxBytes: number;
  userAgent: string;
  maxRedirects?: number;
  accept?: string;
  signal?: AbortSignal;
  /** Injected in tests; an injected fetch owns its own egress. */
  fetchImpl?: typeof fetch;
  /** Re-checked per hop, so a redirect cannot leave an egress allowlist. */
  isEgressAllowed?: (url: string) => boolean;
  /** Runs before each hop — the crawler's per-host rate limit hooks in here. */
  beforeHop?: (url: string) => Promise<void> | void;
}

export type GuardedFetchResult =
  | {
      ok: true;
      /** The FINAL url after redirects — what a favicon or a canonical link is relative to. */
      url: string;
      status: number;
      contentType: string;
      bytes: Buffer;
    }
  | { ok: false; url: string; reason: GuardedFetchReason; error: string; status?: number };

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

/**
 * Fetch a URL's bytes with every guard above applied, or say why not.
 *
 * Returns data on failure rather than throwing, because every caller is
 * rendering the outcome to a person: a bookmark that cannot be previewed still
 * has to draw its link, and a promise rejection makes that the caller's problem
 * to remember.
 */
export async function fetchGuardedBytes(
  target: string,
  opts: GuardedFetchOptions,
): Promise<GuardedFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return { ok: false, url: target, reason: 'network', error: 'Invalid URL.' };
  }

  const signal = combineSignals(opts.timeoutMs, opts.signal);
  const fetcher = opts.fetchImpl ?? fetch;
  const maxRedirects = opts.maxRedirects ?? MAX_GUARDED_REDIRECTS;

  try {
    let res!: Response;
    for (let hop = 0; ; hop += 1) {
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, url: parsed.href, reason: 'network', error: 'Only HTTP and HTTPS URLs can be fetched.' };
      }
      // Credentials in a redirect target are how a chain smuggles a header
      // somewhere the first URL never named.
      if (parsed.username || parsed.password) {
        return { ok: false, url: parsed.href, reason: 'network', error: 'A URL with credentials in it cannot be fetched.' };
      }
      if (opts.isEgressAllowed && !opts.isEgressAllowed(parsed.href)) {
        return { ok: false, url: parsed.href, reason: 'network', error: 'A redirect target was blocked by egress policy.' };
      }
      if (!opts.fetchImpl) {
        const reason = await privateAddressReason(parsed.hostname);
        if (reason) return { ok: false, url: parsed.href, reason: 'network', error: reason };
      }
      if (opts.beforeHop) await opts.beforeHop(parsed.href);

      res = await fetcher(parsed, {
        headers: {
          'User-Agent': opts.userAgent,
          ...(opts.accept ? { Accept: opts.accept } : {}),
        },
        signal,
        redirect: 'manual',
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) break;
        if (hop >= maxRedirects) {
          return { ok: false, url: parsed.href, reason: 'network', error: `Too many redirects (>${maxRedirects}).` };
        }
        try {
          parsed = new URL(location, parsed);
        } catch {
          return { ok: false, url: parsed.href, reason: 'network', error: 'A redirect returned an invalid location.' };
        }
        continue;
      }
      break;
    }

    if (!res.ok) {
      return {
        ok: false, url: parsed.href, reason: 'http-status', status: res.status,
        error: `${res.status} ${res.statusText}`,
      };
    }

    // The declared length first, so an oversized body is refused before it is
    // pulled into memory; the measured length after, because the declaration is
    // a claim the sender controls.
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > opts.maxBytes) {
      return { ok: false, url: parsed.href, reason: 'oversized', error: `Response is ${declared} bytes; limit is ${opts.maxBytes}.` };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > opts.maxBytes) {
      return { ok: false, url: parsed.href, reason: 'oversized', error: `Response is ${bytes.byteLength} bytes; limit is ${opts.maxBytes}.` };
    }

    return {
      ok: true,
      url: parsed.href,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      bytes,
    };
  } catch (err: unknown) {
    const name = (err as { name?: string } | null)?.name;
    const aborted = signal.aborted || name === 'AbortError' || name === 'TimeoutError';
    return {
      ok: false,
      url: parsed.href,
      reason: aborted ? 'timeout' : 'network',
      error: (err as { message?: string } | null)?.message ?? String(err),
    };
  }
}
