import { describe, expect, it, vi } from "vitest";
import { ExternalApiError, fetchWithExternalRetry, retryExternalCall } from "../memory/retry.js";

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
});
