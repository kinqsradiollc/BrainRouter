import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the retry-wrapped fetch so the reranker's network call is fully
// controllable (success / failure) without touching a real endpoint.
vi.mock("../memory/util/retry.js", () => ({
  fetchWithExternalRetry: vi.fn(),
}));
import { fetchWithExternalRetry } from "../memory/util/retry.js";
import {
  RerankerService,
  rerankerTimeoutMs,
  rerankerBreakerThreshold,
  rerankerBreakerCooldownMs,
} from "../memory/store/reranker.js";
import { embeddingTimeoutMs } from "../memory/store/embedding.js";
import {
  acquireLLMSlot,
  acquireEmbeddingSlot,
  acquireRerankerSlot,
  getSemaphoreState,
  getEmbeddingSemaphoreState,
  getRerankerSemaphoreState,
  resetSemaphoreForTests,
} from "../memory/llm/llm-semaphore.js";

// ── Bounded, generative-floor-free timeouts ─────────────────────────────────
// The bug: reranker + embedding (localhost endpoints) inherited the generative
// local floor (up to 10 min via resolveLLMTimeoutMs), so recall stalled past the
// client's MCP timeout. These helpers are bounded and never see that floor.

describe("rerankerTimeoutMs (fast fail, no generative local floor)", () => {
  it("defaults to 15000", () => {
    expect(rerankerTimeoutMs({})).toBe(15_000);
    expect(rerankerTimeoutMs({ BRAINROUTER_RERANKER_TIMEOUT_MS: "" })).toBe(15_000);
  });
  it("parses + clamps to [1000, 120000]; sub-floor / junk → default", () => {
    expect(rerankerTimeoutMs({ BRAINROUTER_RERANKER_TIMEOUT_MS: "5000" })).toBe(5_000);
    expect(rerankerTimeoutMs({ BRAINROUTER_RERANKER_TIMEOUT_MS: "999999" })).toBe(120_000);
    expect(rerankerTimeoutMs({ BRAINROUTER_RERANKER_TIMEOUT_MS: "500" })).toBe(15_000);
    expect(rerankerTimeoutMs({ BRAINROUTER_RERANKER_TIMEOUT_MS: "junk" })).toBe(15_000);
  });
});

describe("embeddingTimeoutMs (fast fail, no generative local floor)", () => {
  it("defaults to 30000", () => {
    expect(embeddingTimeoutMs({})).toBe(30_000);
    expect(embeddingTimeoutMs({ BRAINROUTER_EMBEDDING_TIMEOUT_MS: "" })).toBe(30_000);
  });
  it("parses + clamps to [1000, 120000]; sub-floor / junk → default", () => {
    expect(embeddingTimeoutMs({ BRAINROUTER_EMBEDDING_TIMEOUT_MS: "8000" })).toBe(8_000);
    expect(embeddingTimeoutMs({ BRAINROUTER_EMBEDDING_TIMEOUT_MS: "999999" })).toBe(120_000);
    expect(embeddingTimeoutMs({ BRAINROUTER_EMBEDDING_TIMEOUT_MS: "junk" })).toBe(30_000);
  });
});

describe("reranker breaker knob parsing", () => {
  it("threshold defaults to 3, parses ≥1, junk → default", () => {
    expect(rerankerBreakerThreshold({})).toBe(3);
    expect(rerankerBreakerThreshold({ BRAINROUTER_RERANKER_BREAKER_THRESHOLD: "5" })).toBe(5);
    expect(rerankerBreakerThreshold({ BRAINROUTER_RERANKER_BREAKER_THRESHOLD: "0" })).toBe(3);
  });
  it("cooldown defaults to 30000, parses ≥1000, junk → default", () => {
    expect(rerankerBreakerCooldownMs({})).toBe(30_000);
    expect(rerankerBreakerCooldownMs({ BRAINROUTER_RERANKER_BREAKER_COOLDOWN_MS: "60000" })).toBe(60_000);
    expect(rerankerBreakerCooldownMs({ BRAINROUTER_RERANKER_BREAKER_COOLDOWN_MS: "10" })).toBe(30_000);
  });
});

// ── Circuit breaker ─────────────────────────────────────────────────────────
// A down/overloaded reranker must be SKIPPED for a cooldown instead of paying
// the timeout on every recall. isAvailable() reflects the breaker so recall
// silently uses RRF while it's open.
describe("RerankerService circuit breaker", () => {
  const mockedFetch = vi.mocked(fetchWithExternalRetry);
  const origEnv = { ...process.env };
  let now = 0;

  const makeService = () =>
    new RerankerService({ endpoint: "http://localhost:8000/v1/rerank", apiKey: "k", model: "m", topN: 5 } as any);
  const okResponse = (results: any[]) => ({ ok: true, json: async () => ({ results }) }) as any;

  beforeEach(() => {
    mockedFetch.mockReset();
    now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    process.env.BRAINROUTER_RERANKER_BREAKER_THRESHOLD = "2";
    process.env.BRAINROUTER_RERANKER_BREAKER_COOLDOWN_MS = "1000";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...origEnv };
  });

  it("opens after N consecutive failures; isAvailable() flips false", async () => {
    mockedFetch.mockRejectedValue(new Error("The operation was aborted due to timeout"));
    const svc = makeService();
    expect(svc.isAvailable()).toBe(true);
    await expect(svc.rerank({ query: "q", documents: ["a"] })).rejects.toThrow();
    expect(svc.isAvailable()).toBe(true); // 1 failure < threshold 2
    await expect(svc.rerank({ query: "q", documents: ["a"] })).rejects.toThrow();
    expect(svc.isAvailable()).toBe(false); // breaker open
  });

  it("while open, rerank() fails fast WITHOUT a network call", async () => {
    mockedFetch.mockRejectedValue(new Error("timeout"));
    const svc = makeService();
    await expect(svc.rerank({ query: "q", documents: ["a"] })).rejects.toThrow();
    await expect(svc.rerank({ query: "q", documents: ["a"] })).rejects.toThrow();
    expect(svc.isAvailable()).toBe(false);
    const callsBefore = mockedFetch.mock.calls.length;
    await expect(svc.rerank({ query: "q", documents: ["a"] })).rejects.toThrow(/circuit open/i);
    expect(mockedFetch.mock.calls.length).toBe(callsBefore); // no new fetch while open
  });

  it("recovers after the cooldown and a success closes the circuit", async () => {
    mockedFetch.mockRejectedValue(new Error("timeout"));
    const svc = makeService();
    await expect(svc.rerank({ query: "q", documents: ["a"] })).rejects.toThrow();
    await expect(svc.rerank({ query: "q", documents: ["a"] })).rejects.toThrow();
    expect(svc.isAvailable()).toBe(false);

    now = 1500; // past the 1000ms cooldown → half-open
    expect(svc.isAvailable()).toBe(true);

    mockedFetch.mockResolvedValue(okResponse([{ index: 0, relevance_score: 0.9 }]));
    const out = await svc.rerank({ query: "q", documents: ["a"] });
    expect(out).toEqual([{ index: 0, relevanceScore: 0.9 }]);
    expect(svc.isAvailable()).toBe(true); // closed after the success
  });

  it("a success between failures resets the counter (no premature open)", async () => {
    const svc = makeService();
    mockedFetch.mockRejectedValueOnce(new Error("timeout"));
    await expect(svc.rerank({ query: "q", documents: ["a"] })).rejects.toThrow();
    mockedFetch.mockResolvedValueOnce(okResponse([{ index: 0, relevance_score: 0.5 }]));
    await svc.rerank({ query: "q", documents: ["a"] }); // success → reset
    mockedFetch.mockRejectedValueOnce(new Error("timeout"));
    await expect(svc.rerank({ query: "q", documents: ["a"] })).rejects.toThrow();
    expect(svc.isAvailable()).toBe(true); // only 1 failure since the reset
  });
});

// ── Dual semaphore — embedding pool is independent of the generative cap ─────
describe("generative vs embedding semaphore pools are independent", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
    resetSemaphoreForTests();
  });

  it("a full generative pool (cap=1) does NOT block embedding acquisition", async () => {
    process.env.BRAINROUTER_LLM_MAX_CONCURRENT = "1";
    process.env.BRAINROUTER_EMBED_CONCURRENCY = "2";
    resetSemaphoreForTests();

    const g1 = await acquireLLMSlot(); // generative now full (cap 1)
    // The recall query-embed must still acquire immediately — that's the fix.
    const e1 = await acquireEmbeddingSlot();
    const e2 = await acquireEmbeddingSlot();

    expect(getSemaphoreState().inFlight).toBe(1);
    expect(getSemaphoreState().queued).toBe(0);
    expect(getEmbeddingSemaphoreState().inFlight).toBe(2);

    g1(); e1(); e2();
    expect(getSemaphoreState().inFlight).toBe(0);
    expect(getEmbeddingSemaphoreState().inFlight).toBe(0);
  });

  it("the embedding pool still bounds its own concurrency (cap=1 queues the 2nd)", async () => {
    process.env.BRAINROUTER_EMBED_CONCURRENCY = "1";
    resetSemaphoreForTests();

    const e1 = await acquireEmbeddingSlot();
    let secondAcquired = false;
    const p2 = acquireEmbeddingSlot().then((rel) => { secondAcquired = true; return rel; });
    await Promise.resolve();
    expect(secondAcquired).toBe(false); // queued behind e1
    expect(getEmbeddingSemaphoreState().queued).toBe(1);

    e1();
    const e2 = await p2;
    expect(secondAcquired).toBe(true);
    e2();
  });

  it("the reranker pool defaults to cap=1 and serializes concurrent rerank calls", async () => {
    delete process.env.BRAINROUTER_RERANKER_MAX_CONCURRENT; // default
    resetSemaphoreForTests();
    expect(getRerankerSemaphoreState().cap).toBe(1);

    const r1 = await acquireRerankerSlot(); // single-worker CPU reranker: only one at a time
    let secondAcquired = false;
    const p2 = acquireRerankerSlot().then((rel) => { secondAcquired = true; return rel; });
    await Promise.resolve();
    expect(secondAcquired).toBe(false); // the 2nd recall queues instead of piling on the server
    expect(getRerankerSemaphoreState().queued).toBe(1);

    r1();
    const r2 = await p2;
    expect(secondAcquired).toBe(true);
    r2();
  });

  it("the reranker pool is independent of the generative + embedding pools", async () => {
    process.env.BRAINROUTER_LLM_MAX_CONCURRENT = "1";
    process.env.BRAINROUTER_RERANKER_MAX_CONCURRENT = "1";
    resetSemaphoreForTests();
    const g1 = await acquireLLMSlot();      // generative full
    const r1 = await acquireRerankerSlot(); // reranker still acquires immediately
    expect(getSemaphoreState().inFlight).toBe(1);
    expect(getRerankerSemaphoreState().inFlight).toBe(1);
    g1(); r1();
  });
});
