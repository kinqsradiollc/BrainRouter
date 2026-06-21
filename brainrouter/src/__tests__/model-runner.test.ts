import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelLLMRunner } from "../memory/llm/modelRunner.js";
import {
  cognitiveBreakerOpen,
  recordCognitiveFailure,
  resetCognitiveBreakerForTests,
} from "../memory/llm/cognitive-breaker.js";
import { resetSemaphoreForTests } from "../memory/llm/llm-semaphore.js";

function okResponse(content = "ok-content"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status, statusText: body });
}

function bodyOf(call: unknown[]): any {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("ModelLLMRunner fallback model", () => {
  beforeEach(() => {
    resetCognitiveBreakerForTests();
    resetSemaphoreForTests();
    vi.stubEnv("BRAINROUTER_LLM_API_KEY", "test-key");
    // Keep the endpoint remote so the local 10-min timeout floor doesn't apply.
    vi.stubEnv("BRAINROUTER_LLM_ENDPOINT", "https://example.test/v1/chat/completions");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetCognitiveBreakerForTests();
  });

  it("falls back to BRAINROUTER_LLM_FALLBACK_MODEL on 502, then succeeds", async () => {
    vi.stubEnv("BRAINROUTER_LLM_FALLBACK_MODEL", "fallback-model");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(502, "Bad Gateway"))
      .mockResolvedValueOnce(okResponse("from-fallback"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ModelLLMRunner().run({ prompt: "hi", taskId: "cognitive-extraction" });

    expect(result).toBe("from-fallback");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0]).model).toBe("gpt-4o-mini");
    expect(bodyOf(fetchMock.mock.calls[1]).model).toBe("fallback-model");
  });

  it("does NOT fall back on a 400 client error", async () => {
    vi.stubEnv("BRAINROUTER_LLM_FALLBACK_MODEL", "fallback-model");
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, "Bad Request"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ModelLLMRunner().run({ prompt: "hi", taskId: "t" })).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no fallback model is configured", async () => {
    vi.stubEnv("BRAINROUTER_LLM_FALLBACK_MODEL", "");
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(502, "Bad Gateway"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ModelLLMRunner().run({ prompt: "hi", taskId: "t" })).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back on a timeout error", async () => {
    vi.stubEnv("BRAINROUTER_LLM_FALLBACK_MODEL", "fallback-model");
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce(okResponse("recovered"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ModelLLMRunner().run({ prompt: "hi", taskId: "t" });

    expect(result).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the LM-Studio unload retry after the refactor", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(400, "Model is unloaded."))
      .mockResolvedValueOnce(okResponse("loaded-now"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ModelLLMRunner().run({ prompt: "hi", taskId: "t" });

    expect(result).toBe("loaded-now");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("ModelLLMRunner request body options", () => {
  beforeEach(() => {
    resetCognitiveBreakerForTests();
    resetSemaphoreForTests();
    vi.stubEnv("BRAINROUTER_LLM_API_KEY", "test-key");
    vi.stubEnv("BRAINROUTER_LLM_ENDPOINT", "https://example.test/v1/chat/completions");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetCognitiveBreakerForTests();
  });

  it("omits response_format by default and includes max_tokens when set", async () => {
    vi.stubEnv("BRAINROUTER_LLM_MAX_TOKENS", "256");
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await new ModelLLMRunner().run({ prompt: "hi", taskId: "cognitive-extraction" });

    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.max_tokens).toBe(256);
    expect(body.response_format).toBeUndefined();
  });

  it("adds response_format for extraction only when JSON mode is on", async () => {
    vi.stubEnv("BRAINROUTER_LLM_JSON_MODE", "on");
    // Fresh Response per call — a body can only be read once, and run() is called twice here.
    const fetchMock = vi.fn().mockImplementation(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await new ModelLLMRunner().run({ prompt: "hi", taskId: "cognitive-extraction" });
    await new ModelLLMRunner().run({ prompt: "hi", taskId: "graph-extraction" });

    expect(bodyOf(fetchMock.mock.calls[0]).response_format).toEqual({ type: "json_object" });
    expect(bodyOf(fetchMock.mock.calls[1]).response_format).toBeUndefined();
  });
});

describe("cognitive circuit breaker", () => {
  beforeEach(() => {
    resetCognitiveBreakerForTests();
    resetSemaphoreForTests();
    vi.stubEnv("BRAINROUTER_LLM_API_KEY", "test-key");
    vi.stubEnv("BRAINROUTER_LLM_ENDPOINT", "https://example.test/v1/chat/completions");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetCognitiveBreakerForTests();
  });

  it("opens after the configured number of consecutive failures", () => {
    vi.stubEnv("BRAINROUTER_COGNITIVE_BREAKER_THRESHOLD", "2");
    expect(cognitiveBreakerOpen()).toBe(false);
    recordCognitiveFailure();
    expect(cognitiveBreakerOpen()).toBe(false);
    recordCognitiveFailure();
    expect(cognitiveBreakerOpen()).toBe(true);
  });

  it("re-closes after the cooldown elapses", () => {
    vi.useFakeTimers();
    vi.stubEnv("BRAINROUTER_COGNITIVE_BREAKER_THRESHOLD", "1");
    vi.stubEnv("BRAINROUTER_COGNITIVE_BREAKER_COOLDOWN_MS", "5000");

    recordCognitiveFailure();
    expect(cognitiveBreakerOpen()).toBe(true);

    vi.advanceTimersByTime(5001);
    expect(cognitiveBreakerOpen()).toBe(false);
  });

  it("fast-fails the runner without fetching while the circuit is open", async () => {
    vi.stubEnv("BRAINROUTER_COGNITIVE_BREAKER_THRESHOLD", "1");
    recordCognitiveFailure(); // opens the circuit
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ModelLLMRunner().run({ prompt: "hi", taskId: "t" }))
      .rejects.toThrow(/circuit open/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
