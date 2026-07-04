/**
 * MC-A5 — JIT secret indirection: a host-side token BROKER that replaces
 * baked env secrets with point-of-use lookup for runtime children.
 *
 * Instead of handing a child runtime the raw value of every credential in its
 * environment, the host keeps the values behind named providers and issues the
 * child a LEASE — a random, single-use, short-TTL, scope-checked token carried
 * as `BRAINROUTER_SECRET_LEASE_<NAME>`. The layer that actually needs the
 * value (the exec/tool layer today; the container/remote backends over the
 * loopback bridge later) redeems the lease at point-of-use:
 *
 *   registerSecret(name, provider)  — provider resolves the value ON DEMAND
 *                                     (config secrets, connector credential
 *                                     store, plain captured env value, …).
 *   issue(name, { ttlMs, scope })   — mint a lease token for one redemption.
 *   redeem(token, { scope })        — resolve the provider ONCE; a second
 *                                     redeem, an expired lease, or a scope
 *                                     mismatch all fail.
 *
 * Everything is opt-in behind `cli.runtime.jitSecrets` (default false — child
 * env is byte-for-byte what it is today). Secret VALUES never appear in lease
 * records, error messages, or anything else this module emits.
 */

import { randomBytes } from 'node:crypto';

/** Resolves a secret's value on demand — only ever called at redemption. */
export type SecretProvider = () => string | Promise<string>;

export interface SecretLeaseOptions {
  /** Lease lifetime in ms (clamped ≥ 1s). Default 60s — long enough to cross
   *  a spawn boundary, short enough that a leaked token goes stale fast. */
  ttlMs?: number;
  /** Opaque scope tag the redeemer must present verbatim ('' = unscoped). */
  scope?: string;
}

/** Env-var prefix a leased secret travels under: `<PREFIX><NAME>=<token>`. */
export const SECRET_LEASE_ENV_PREFIX = 'BRAINROUTER_SECRET_LEASE_';

const LEASE_TOKEN_PREFIX = 'brsl_';
const DEFAULT_LEASE_TTL_MS = 60_000;
const MIN_LEASE_TTL_MS = 1_000;

interface LeaseEntry {
  name: string;
  scope: string;
  expiresAt: number;
}

/** Generic redeem failure — deliberately does not say WHICH check failed for
 *  unknown/expired/spent tokens (an attacker probing tokens learns nothing). */
const LEASE_INVALID = 'secret lease is unknown, expired, or already redeemed';

export class SecretBroker {
  private readonly providers = new Map<string, SecretProvider>();
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  /** Register (or replace) the on-demand provider behind `name`. */
  registerSecret(name: string, provider: SecretProvider): void {
    const key = name?.trim();
    if (!key) throw new Error('secret name must be a non-empty string');
    this.providers.set(key, provider);
  }

  /** Whether a provider is registered under `name`. */
  hasSecret(name: string): boolean {
    return this.providers.has(name?.trim() ?? '');
  }

  /**
   * Mint a single-use lease for `name`. The provider is NOT resolved here —
   * issuing is cheap and never touches the underlying credential.
   */
  issue(name: string, opts?: SecretLeaseOptions): string {
    const key = name?.trim();
    if (!key || !this.providers.has(key)) {
      throw new Error(`no secret provider registered under '${key ?? ''}'`);
    }
    this.pruneExpired();
    const ttlMs = Math.max(MIN_LEASE_TTL_MS, Math.floor(opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS));
    const token = LEASE_TOKEN_PREFIX + randomBytes(24).toString('hex');
    this.leases.set(token, { name: key, scope: opts?.scope ?? '', expiresAt: this.now() + ttlMs });
    return token;
  }

  /**
   * Redeem a lease exactly once. Order of checks:
   *  - unknown/spent token → fails (generic message);
   *  - expired lease → fails (the entry is dropped);
   *  - scope mismatch → fails WITHOUT burning the lease (the token holder
   *    presented the wrong scope; the rightful scoped redeemer still can);
   *  - success → the lease is burned BEFORE the provider runs (a throwing
   *    provider still consumes the lease — fail closed, never retryable).
   */
  async redeem(leaseToken: string, opts?: { scope?: string }): Promise<string> {
    this.pruneExpired();
    const entry = this.leases.get(leaseToken);
    if (!entry) throw new Error(LEASE_INVALID);
    if (entry.expiresAt <= this.now()) {
      this.leases.delete(leaseToken);
      throw new Error(LEASE_INVALID);
    }
    if (entry.scope !== (opts?.scope ?? '')) {
      throw new Error(`secret lease scope mismatch for '${entry.name}'`);
    }
    this.leases.delete(leaseToken); // single-use: burn before resolving
    const provider = this.providers.get(entry.name);
    if (!provider) throw new Error(`no secret provider registered under '${entry.name}'`);
    return provider();
  }

  /** Live (unexpired, unredeemed) lease count — observability/tests. */
  leaseCount(): number {
    this.pruneExpired();
    return this.leases.size;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.leases) {
      if (entry.expiresAt <= now) this.leases.delete(token);
    }
  }
}

// ---------------------------------------------------------------------------
// Env-shaped helpers: raw env ⇄ leased env
// ---------------------------------------------------------------------------

export interface LeaseSecretEnvOptions extends SecretLeaseOptions {
  /** Which vars count as secrets (the caller supplies the detector so this
   *  module stays dependency-free — e.g. the exec layer's secret-shape check). */
  isSecret: (name: string, value: string | undefined) => boolean;
}

/** True when `env` carries at least one `BRAINROUTER_SECRET_LEASE_*` entry. */
export function hasSecretLeaseEnv(env: Record<string, string | undefined>): boolean {
  return Object.keys(env).some((name) => name.startsWith(SECRET_LEASE_ENV_PREFIX));
}

/**
 * Replace every secret-shaped var in `env` with a lease indirection:
 * `FOO=<raw>` becomes `BRAINROUTER_SECRET_LEASE_FOO=<token>` (raw value gone),
 * registering a provider that returns the captured value on redemption.
 * Non-secret vars pass through untouched; already-leased vars are kept as-is.
 */
export function leaseSecretEnv(
  env: Record<string, string | undefined>,
  broker: SecretBroker,
  opts: LeaseSecretEnvOptions,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(SECRET_LEASE_ENV_PREFIX)) { out[name] = value; continue; }
    if (typeof value === 'string' && opts.isSecret(name, value)) {
      broker.registerSecret(name, () => value);
      out[SECRET_LEASE_ENV_PREFIX + name] = broker.issue(name, { ttlMs: opts.ttlMs, scope: opts.scope });
      continue;
    }
    out[name] = value;
  }
  return out;
}

export interface ResolvedLeaseEnv {
  env: Record<string, string | undefined>;
  /** NAMES (never values) of leases that failed to redeem — those vars are
   *  dropped rather than passed through as dangling tokens. */
  failed: string[];
}

/**
 * Point-of-use resolution: redeem every `BRAINROUTER_SECRET_LEASE_<NAME>`
 * entry back into `<NAME>=<value>`. A lease that fails (expired, spent, wrong
 * scope) drops its var and reports the NAME in `failed` — never throws the
 * whole env away and never logs a value.
 */
export async function resolveLeaseEnv(
  env: Record<string, string | undefined>,
  broker: SecretBroker,
  opts?: { scope?: string },
): Promise<ResolvedLeaseEnv> {
  const out: Record<string, string | undefined> = {};
  const failed: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(SECRET_LEASE_ENV_PREFIX)) { out[name] = value; continue; }
    const secretName = name.slice(SECRET_LEASE_ENV_PREFIX.length);
    try {
      out[secretName] = await broker.redeem(value ?? '', { scope: opts?.scope });
    } catch {
      failed.push(secretName);
    }
  }
  return { env: out, failed };
}

/**
 * MC-A5 child-env chokepoint used by the runtime manager: with `jitSecrets`
 * OFF (the default) the env is returned UNCHANGED — byte-for-byte today's
 * behavior. With it ON, secret-shaped entries become lease indirections.
 * Pure over its inputs so it tests hermetically without knob overrides.
 */
export function prepareRuntimeChildEnv(
  env: Record<string, string> | undefined,
  opts: {
    jitSecrets: boolean;
    ttlMs: number;
    scope: string;
    isSecret: (name: string, value: string | undefined) => boolean;
    broker: SecretBroker;
  },
): Record<string, string> | undefined {
  if (!env || !opts.jitSecrets) return env;
  const leased = leaseSecretEnv(env, opts.broker, { ttlMs: opts.ttlMs, scope: opts.scope, isSecret: opts.isSecret });
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(leased)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Process-wide broker (the in-process seam)
// ---------------------------------------------------------------------------
//
// One broker per host process: the runtime manager leases into it and the
// exec layer redeems out of it. Isolated backends will reach the SAME broker
// over the loopback bridge later — the API above is the contract.

let globalBroker: SecretBroker | undefined;

export function getSecretBroker(): SecretBroker {
  if (!globalBroker) globalBroker = new SecretBroker();
  return globalBroker;
}

/** Test hook — drop the process-wide broker (leases and providers vanish). */
export function _resetSecretBroker(): void {
  globalBroker = undefined;
}
