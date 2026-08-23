import { describe, expect, it, vi } from "vitest";
import {
  computeBackoffMs,
  ExternalApiError,
  fetchWithExternalRetry,
  isTransientConnectionBody,
  parseRetryAfterMs,
  retryExternalCall,
} from "../memory/util/retry.js";

describe("external API retry helpers", () => {
  it("retries retryable HTTP errors and returns the successful response", async () => {
    const responses = [
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
      new Response("unavailable", { status: 503, statusText: "Service Unavailable" }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithExternalRetry("https://example.test/api", {}, {
      label: "test API",
      sleep: async () => undefined,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("does not retry non-retryable external API errors", async () => {
    const operation = vi.fn(async () => {
      throw new ExternalApiError("bad request", 400);
    });

    await expect(retryExternalCall(operation, {
      label: "test API",
      sleep: async () => undefined,
    })).rejects.toThrow("bad request");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries a transient connection drop reported as a 400, then succeeds", async () => {
    // LM Studio / proxy gateways report a dropped connection as a 400 whose body
    // names the real cause. Without body inspection this permanently drops the
    // record's embedding; we must retry it.
    const responses = [
      new Response(JSON.stringify({ error: "LM Link connection closed." }), {
        status: 400,
        statusText: "Bad Request",
      }),
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithExternalRetry("https://example.test/embeddings", {}, {
      label: "Embedding API",
      sleep: async () => undefined,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("does not retry a genuine 4xx and leaves the body readable for the caller", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid api key" }), {
        status: 401,
        statusText: "Unauthorized",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithExternalRetry("https://example.test/embeddings", {}, {
      label: "Embedding API",
      sleep: async () => undefined,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
    // The reconstructed Response must still expose the original body so the
    // caller's `await res.text()` error path keeps working.
    await expect(response.text()).resolves.toContain("invalid api key");
    vi.unstubAllGlobals();
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("  10 ")).toBe(10000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });
  it("parses an HTTP-date relative to now", () => {
    const now = 1_000_000_000_000;
    const three = parseRetryAfterMs(new Date(now + 3000).toUTCString(), now);
    // UTCString truncates to whole seconds, so allow up to 1s of rounding slack.
    expect(three).toBeGreaterThanOrEqual(2000);
    expect(three).toBeLessThanOrEqual(3000);
  });
  it("returns undefined for missing / unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("computeBackoffMs", () => {
  it("applies equal jitter (half fixed, half random) to the exponential base", () => {
    // attempt 0, base 2000: exp=2000 → 1000 + random*1000
    expect(computeBackoffMs(0, 2000, 30000, undefined, () => 0)).toBe(1000);
    expect(computeBackoffMs(0, 2000, 30000, undefined, () => 1)).toBe(2000);
    // attempt 1: exp=4000 → 2000 + random*2000
    expect(computeBackoffMs(1, 2000, 30000, undefined, () => 0.5)).toBe(3000);
  });
  it("honors a larger server Retry-After over the jittered backoff", () => {
    expect(computeBackoffMs(0, 2000, 30000, 10000, () => 0.5)).toBe(10000);
    // …but a smaller Retry-After doesn't shrink the backoff below the jitter floor.
    expect(computeBackoffMs(1, 2000, 30000, 100, () => 0)).toBe(2000);
  });
  it("caps both exponential growth and a huge Retry-After at maxDelayMs", () => {
    expect(computeBackoffMs(20, 2000, 30000, undefined, () => 1)).toBe(30000);
    expect(computeBackoffMs(0, 2000, 30000, 99_999_999, () => 0)).toBe(30000);
  });
});

describe("fetchWithExternalRetry honors Retry-After", () => {
  it("waits the server-requested time on a 429 before retrying", async () => {
    const responses = [
      new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const slept: number[] = [];

    const response = await fetchWithExternalRetry("https://example.test/api", {}, {
      label: "test API",
      sleep: async (ms) => { slept.push(ms); },
      random: () => 0, // jitter floor is 1000ms at attempt 0 → Retry-After (7000) must win
    });

    expect(response.status).toBe(200);
    expect(slept).toEqual([7000]);
    vi.unstubAllGlobals();
  });
});

describe("isTransientConnectionBody", () => {
  it("matches recoverable connection / availability blips", () => {
    for (const body of [
      '{"error":"LM Link connection closed."}',
      "connection reset by peer",
      "socket hang up",
      "ECONNRESET",
      "the model is still loading, please try again",
      "service temporarily unavailable",
    ]) {
      expect(isTransientConnectionBody(body)).toBe(true);
    }
  });

  it("does not match genuine client errors or empty bodies", () => {
    for (const body of [
      '{"error":"invalid api key"}',
      "context length exceeded",
      "model not found",
      "",
      null,
      undefined,
    ]) {
      expect(isTransientConnectionBody(body)).toBe(false);
    }
  });

  it("ADR-039: routes through an injected fetchImpl and preserves the retry loop", async () => {
    const calls: string[] = []; let attempt = 0;
    const injected = vi.fn(async (input: string | URL | Request, _i: RequestInit): Promise<Response> => {
      calls.push(String(input)); attempt += 1;
      return attempt === 1 ? new Response("busy", { status: 503 })
        : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const res = await fetchWithExternalRetry("http://provider.example/v1/embeddings", { method: "POST" },
      { label: "embed", maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 }, injected);
    expect(res.status).toBe(200);
    expect(injected).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["http://provider.example/v1/embeddings", "http://provider.example/v1/embeddings"]);
  });
});
