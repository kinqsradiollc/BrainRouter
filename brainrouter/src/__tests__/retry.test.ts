import { describe, expect, it, vi } from "vitest";
import {
  ExternalApiError,
  fetchWithExternalRetry,
  isTransientConnectionBody,
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
});
