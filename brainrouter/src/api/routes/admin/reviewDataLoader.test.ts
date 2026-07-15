import { describe, expect, it, vi } from "vitest";
import { createReviewPullRequestLoader } from "./reviewDataLoader.js";

interface Row { repo: string; number: number }

describe("review pull request loader", () => {
  it("bounds repository fan-out and preserves every successful row", async () => {
    let active = 0;
    let peak = 0;
    const loader = createReviewPullRequestLoader<Row>({ concurrency: 8 });
    const repos = Array.from({ length: 40 }, (_, index) => `owner/repo-${index}`);

    const result = await loader.load({
      cacheKey: "org:user:account:https://api.github.com",
      repos,
      fetchRepo: async (repo) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { status: "ok", rows: [{ repo, number: 1 }] };
      },
    });

    expect(peak).toBeLessThanOrEqual(8);
    expect(result.rows).toHaveLength(40);
    expect(result.partial).toBe(false);
  });

  it("returns a fresh cache entry without another GitHub call", async () => {
    const fetchRepo = vi.fn(async (repo: string) => ({ status: "ok" as const, rows: [{ repo, number: 1 }] }));
    const loader = createReviewPullRequestLoader<Row>({ freshMs: 30_000 });
    const input = { cacheKey: "one", repos: ["o/r"], fetchRepo };

    expect((await loader.load(input)).fresh).toBe(true);
    expect((await loader.load(input)).fresh).toBe(true);
    expect(fetchRepo).toHaveBeenCalledTimes(1);
  });

  it("serves stale data immediately and deduplicates the background refresh", async () => {
    let now = 1_000;
    let release!: () => void;
    const refreshGate = new Promise<void>((resolve) => { release = resolve; });
    const fetchRepo = vi.fn()
      .mockResolvedValueOnce({ status: "ok", rows: [{ repo: "o/r", number: 1 }] })
      .mockImplementationOnce(async () => {
        await refreshGate;
        return { status: "ok", rows: [{ repo: "o/r", number: 2 }] };
      });
    const loader = createReviewPullRequestLoader<Row>({ now: () => now, freshMs: 100, staleMs: 5_000 });
    const input = { cacheKey: "one", repos: ["o/r"], fetchRepo };
    await loader.load(input);
    now += 101;

    const [left, right] = await Promise.all([loader.load(input), loader.load(input)]);
    expect(left.rows[0]?.number).toBe(1);
    expect(right.rows[0]?.number).toBe(1);
    expect(left.refreshing).toBe(true);
    expect(fetchRepo).toHaveBeenCalledTimes(2);

    release();
    const refreshed = await loader.load({ ...input, force: true });
    expect(refreshed.rows[0]?.number).toBe(2);
  });

  it("returns partial successes and names failed repositories", async () => {
    const loader = createReviewPullRequestLoader<Row>();
    const result = await loader.load({
      cacheKey: "partial",
      repos: ["o/good", "o/bad"],
      fetchRepo: async (repo) => {
        if (repo.endsWith("bad")) throw new Error("unavailable");
        return { status: "ok", rows: [{ repo, number: 7 }] };
      },
    });
    expect(result.rows).toEqual([{ repo: "o/good", number: 7 }]);
    expect(result.partial).toBe(true);
    expect(result.failedRepositories).toEqual(["o/bad"]);
  });

  it("reuses per-repository data after an ETag not-modified response", async () => {
    let version = 0;
    const loader = createReviewPullRequestLoader<Row>({ freshMs: 0 });
    const fetchRepo = vi.fn(async (_repo: string, etag?: string) => {
      version += 1;
      if (etag === "v1") return { status: "not-modified" as const, etag };
      return { status: "ok" as const, etag: "v1", rows: [{ repo: "o/r", number: version }] };
    });
    const input = { cacheKey: "etag", repos: ["o/r"], fetchRepo };
    const first = await loader.load(input);
    const second = await loader.load({ ...input, force: true });
    expect(second.rows).toEqual(first.rows);
    expect(fetchRepo).toHaveBeenLastCalledWith("o/r", "v1", expect.any(AbortSignal));
  });
});
