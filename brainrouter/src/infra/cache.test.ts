import { describe, it, expect, vi, afterEach } from "vitest";
import { createCache, redisUrlFromEnv, isRedisConfigured, cacheKeyFromFilters } from "./cache.js";

/**
 * In-process behaviour only — no Redis is contacted here (createCache() with no
 * URL uses the bounded TTL map). The Redis path is a thin structural wrapper and
 * is exercised end-to-end by the docker compose stack.
 */
describe("infra/cache", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("reads the connection string from either env var", () => {
    expect(redisUrlFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(isRedisConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(redisUrlFromEnv({ REDIS_URL: "redis://a:6379" } as NodeJS.ProcessEnv)).toBe("redis://a:6379");
    // BRAINROUTER_REDIS_URL wins over REDIS_URL.
    expect(redisUrlFromEnv({ BRAINROUTER_REDIS_URL: "redis://b", REDIS_URL: "redis://a" } as NodeJS.ProcessEnv)).toBe("redis://b");
    expect(isRedisConfigured({ REDIS_URL: "  " } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("builds an order-independent filter key that drops empties", () => {
    const a = cacheKeyFromFilters("vuln:list", { severity: "high", limit: 50, search: undefined, kevOnly: false });
    const b = cacheKeyFromFilters("vuln:list", { limit: 50, kevOnly: false, severity: "high" });
    expect(a).toBe(b);
    expect(a).toContain("severity=high");
    expect(a).not.toContain("search");
    // false/0 are meaningful values and must be kept; only undefined/null/"" drop.
    expect(a).toContain("kevOnly=false");
  });

  it("round-trips values and treats a miss as undefined", async () => {
    const cache = createCache();
    expect(await cache.get("k")).toBeUndefined();
    await cache.set("k", { n: 1 }, 60);
    expect(await cache.get<{ n: number }>("k")).toEqual({ n: 1 });
  });

  it("caches null as a hit but never stores undefined", async () => {
    const cache = createCache();
    await cache.set("nul", null, 60);
    expect(await cache.get("nul")).toBeNull();
    await cache.set("und", undefined, 60);
    expect(await cache.get("und")).toBeUndefined();
  });

  it("expires entries after the TTL", async () => {
    vi.useFakeTimers();
    const cache = createCache();
    await cache.set("k", "v", 1);
    expect(await cache.get("k")).toBe("v");
    vi.advanceTimersByTime(1_100);
    expect(await cache.get("k")).toBeUndefined();
  });

  it("wrap computes once and serves the cached value after", async () => {
    const cache = createCache();
    const compute = vi.fn(async () => 42);
    expect(await cache.wrap("w", 60, compute)).toBe(42);
    expect(await cache.wrap("w", 60, compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("wrap single-flights concurrent misses", async () => {
    const cache = createCache();
    let calls = 0;
    const compute = () => new Promise<number>((r) => { calls++; setTimeout(() => r(7), 5); });
    const [a, b] = await Promise.all([cache.wrap("s", 60, compute), cache.wrap("s", 60, compute)]);
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(calls).toBe(1);
  });

  it("deletes exact keys and by prefix", async () => {
    const cache = createCache();
    await cache.set("vuln:cve:CVE-1", 1, 60);
    await cache.set("vuln:cve:CVE-2", 2, 60);
    await cache.set("other", 3, 60);
    await cache.del("vuln:cve:CVE-1");
    expect(await cache.get("vuln:cve:CVE-1")).toBeUndefined();
    expect(await cache.get("vuln:cve:CVE-2")).toBe(2);
    await cache.del("vuln:cve:*");
    expect(await cache.get("vuln:cve:CVE-2")).toBeUndefined();
    expect(await cache.get("other")).toBe(3);
  });
});
