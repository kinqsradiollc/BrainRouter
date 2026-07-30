/**
 * Optional Redis-backed read cache with an in-process fallback.
 *
 * Redis is INFRASTRUCTURE config (like DATABASE_URL), so the connection string
 * comes from the environment — `BRAINROUTER_REDIS_URL` (preferred) or the
 * conventional `REDIS_URL`. It is entirely optional:
 *   - URL set + `ioredis` installed  → shared, restart-surviving cache.
 *   - otherwise                       → a bounded in-process TTL map.
 * Either way correctness is identical; only cross-process sharing differs.
 *
 * Cache errors NEVER propagate to the caller. A failed get/set simply falls
 * through to recompute — a cache is an accelerator, never a dependency. That is
 * why `ioredis` is an OPTIONAL dependency and is loaded through a non-literal
 * dynamic import: the server builds and runs whether or not it is present.
 */

/** Minimal structural view of the ioredis client — avoids a hard type dep. */
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSec: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  scan(cursor: string, matchWord: "MATCH", pattern: string, countWord: "COUNT", count: number): Promise<[string, string[]]>;
  quit(): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}
type RedisCtor = new (url: string, opts?: Record<string, unknown>) => RedisLike;

const NS = "br:cache:";

export function redisUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = (env.BRAINROUTER_REDIS_URL ?? env.REDIS_URL ?? "").trim();
  return url.length > 0 ? url : undefined;
}

/** True when a Redis endpoint is configured (else the in-process cache is used). */
export function isRedisConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return redisUrlFromEnv(env) !== undefined;
}

let warnedNoLib = false;
async function connectRedis(url: string): Promise<RedisLike | null> {
  try {
    // Non-literal specifier: TypeScript treats this as `any` and never resolves
    // `ioredis` at compile time, so the module stays genuinely optional.
    const spec = "ioredis";
    const mod = (await import(spec)) as { default?: RedisCtor } & Partial<{ Redis: RedisCtor }>;
    const Ctor = mod.default ?? mod.Redis;
    if (!Ctor) throw new Error("ioredis has no default export");
    // enableOfflineQueue:false → commands FAIL FAST when the socket is down, so a
    // get/set falls straight through to the in-process path instead of hanging
    // and blocking the request. retryStrategy keeps reconnecting in the
    // background so the cache recovers on its own when Redis comes back.
    const client = new Ctor(url, {
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
      keyPrefix: "",
    });
    let warnedConn = false;
    client.on("error", (err) => {
      // Redis is best-effort; log ONCE (ioredis re-emits on every reconnect) and
      // keep serving from the in-process cache.
      if (!warnedConn) { warnedConn = true; console.warn(`[cache] redis unavailable, using in-process cache: ${(err as Error)?.message ?? err}`); }
    });
    return client;
  } catch {
    if (!warnedNoLib) {
      warnedNoLib = true;
      console.warn("[cache] BRAINROUTER_REDIS_URL is set but 'ioredis' is not installed — using the in-process cache. Run `npm i ioredis` in the brain to enable the shared cache.");
    }
    return null;
  }
}

export interface Cache {
  /** Cached value, or `undefined` on miss (stored `null` is a hit and returns null). */
  get<T>(key: string): Promise<T | undefined>;
  /** Store a value under `key` for `ttlSec` seconds. `undefined` is never stored. */
  set<T>(key: string, value: T, ttlSec: number): Promise<void>;
  /** Delete a single key (exact) — `key.endsWith("*")` deletes by prefix. */
  del(key: string): Promise<void>;
  /** Return the cached value or compute + store it (single-flight per process). */
  wrap<T>(key: string, ttlSec: number, compute: () => Promise<T>): Promise<T>;
  /** Release the backing connection (tests / graceful shutdown). */
  close(): Promise<void>;
}

class CacheImpl implements Cache {
  private redis: Promise<RedisLike | null> | null = null;
  private readonly mem = new Map<string, { json: string; expires: number }>();
  private readonly memMax = 5000;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly url: string | undefined) {}

  private client(): Promise<RedisLike | null> {
    if (!this.url) return Promise.resolve(null);
    if (!this.redis) this.redis = connectRedis(this.url);
    return this.redis;
  }

  private memGet(key: string): string | undefined {
    const hit = this.mem.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) { this.mem.delete(key); return undefined; }
    return hit.json;
  }

  private memSet(key: string, json: string, ttlSec: number): void {
    if (this.mem.size >= this.memMax) {
      // Evict the oldest ~1% to keep the map bounded (insertion-ordered Map).
      const drop = Math.max(1, Math.floor(this.memMax / 100));
      let n = 0;
      for (const k of this.mem.keys()) { this.mem.delete(k); if (++n >= drop) break; }
    }
    this.mem.set(key, { json, expires: Date.now() + ttlSec * 1000 });
  }

  async get<T>(key: string): Promise<T | undefined> {
    const full = NS + key;
    try {
      const redis = await this.client();
      const json = redis ? await redis.get(full) : this.memGet(full);
      return json == null ? undefined : (JSON.parse(json) as T);
    } catch {
      const json = this.memGet(full);
      return json == null ? undefined : (JSON.parse(json) as T);
    }
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    if (value === undefined || ttlSec <= 0) return;
    const full = NS + key;
    let json: string;
    try { json = JSON.stringify(value); } catch { return; }
    this.memSet(full, json, ttlSec); // keep the in-process copy warm regardless
    try {
      const redis = await this.client();
      if (redis) await redis.set(full, json, "EX", ttlSec);
    } catch { /* best-effort */ }
  }

  async del(key: string): Promise<void> {
    const full = NS + key;
    if (key.endsWith("*")) {
      const prefix = full.slice(0, -1);
      for (const k of [...this.mem.keys()]) if (k.startsWith(prefix)) this.mem.delete(k);
      try {
        const redis = await this.client();
        if (redis) {
          let cursor = "0";
          do {
            const [next, batch] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
            cursor = next;
            if (batch.length) await redis.del(...batch);
          } while (cursor !== "0");
        }
      } catch { /* best-effort */ }
      return;
    }
    this.mem.delete(full);
    try {
      const redis = await this.client();
      if (redis) await redis.del(full);
    } catch { /* best-effort */ }
  }

  async wrap<T>(key: string, ttlSec: number, compute: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== undefined) return hit;
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const run = (async () => {
      try {
        const value = await compute();
        await this.set(key, value, ttlSec);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, run);
    return run;
  }

  async close(): Promise<void> {
    this.mem.clear();
    this.inflight.clear();
    const redis = this.redis ? await this.redis : null;
    this.redis = null;
    if (redis) { try { await redis.quit(); } catch { /* ignore */ } }
  }
}

/** A standalone cache bound to `url` (or the in-process fallback when omitted). */
export function createCache(url?: string): Cache {
  return new CacheImpl(url);
}

let singleton: Cache | null = null;

/** Process-wide cache singleton, wired to `BRAINROUTER_REDIS_URL` if present. */
export function getCache(): Cache {
  if (!singleton) singleton = new CacheImpl(redisUrlFromEnv());
  return singleton;
}

/** Replace the singleton (tests only). */
export function __setCacheForTests(cache: Cache | null): void {
  singleton = cache;
}

/** A stable string key from an arbitrary filter object (order-independent). */
export function cacheKeyFromFilters(prefix: string, filters: Record<string, unknown>): string {
  const parts = Object.keys(filters)
    .sort()
    .filter((k) => filters[k] !== undefined && filters[k] !== null && filters[k] !== "")
    .map((k) => `${k}=${String(filters[k])}`);
  return `${prefix}:${parts.join("&")}`;
}
