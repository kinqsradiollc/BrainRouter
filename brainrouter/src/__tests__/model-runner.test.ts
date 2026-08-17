import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelLLMRunner, type LlmProviderOverride } from "../memory/llm/modelRunner.js";

// ADR-039 — the memory-pipeline dispatch now validates the target through the
// upstream policy (DNS resolve). Mock DNS so fake test hosts resolve to a PUBLIC IP
// (policy admits public, refuses internal — see policyFetch.test.ts).
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));

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

function toolResponse(name: string, args: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { tool_calls: [{ type: "function", function: { name, arguments: args } }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function bodyOf(call: unknown[]): any {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string);
}

/**
 * ADR-012 — the runner's credentials now come from the DB-resolved provider
 * override, not `.env`. `mk()` sets a remote-endpoint override (so the local
 * timeout floor doesn't apply) and merges any per-test fields (e.g. fallback).
 */
function mk(over: Partial<LlmProviderOverride> = {}): ModelLLMRunner {
  const r = new ModelLLMRunner();
  r.setProviderOverride({ endpoint: "https://example.test/v1/chat/completions", apiKey: "test-key", ...over });
  return r;
}

describe("ModelLLMRunner fallback model", () => {
  beforeEach(() => {
    resetCognitiveBreakerForTests();
    resetSemaphoreForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetCognitiveBreakerForTests();
  });

  it("falls back to the provider's fallbackModel on 502, then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(502, "Bad Gateway"))
      .mockResolvedValueOnce(okResponse("from-fallback"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mk({ fallbackModel: "fallback-model" }).run({ prompt: "hi", taskId: "cognitive-extraction" });

    expect(result).toBe("from-fallback");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0]).model).toBe("gpt-4o-mini");
    expect(bodyOf(fetchMock.mock.calls[1]).model).toBe("fallback-model");
  });

  it("does NOT fall back on a 400 client error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, "Bad Request"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mk({ fallbackModel: "fallback-model" }).run({ prompt: "hi", taskId: "t" })).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no fallback model is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(502, "Bad Gateway"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mk().run({ prompt: "hi", taskId: "t" })).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back on a timeout error", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce(okResponse("recovered"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mk({ fallbackModel: "fallback-model" }).run({ prompt: "hi", taskId: "t" });

    expect(result).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the LM-Studio unload retry after the refactor", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(400, "Model is unloaded."))
      .mockResolvedValueOnce(okResponse("loaded-now"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mk().run({ prompt: "hi", taskId: "t" });

    expect(result).toBe("loaded-now");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is unconfigured (LLM_NOT_CONFIGURED) when no provider override is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    await expect(new ModelLLMRunner().run({ prompt: "hi", taskId: "t" })).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ModelLLMRunner request body options", () => {
  beforeEach(() => {
    resetCognitiveBreakerForTests();
    resetSemaphoreForTests();
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

    await mk().run({ prompt: "hi", taskId: "cognitive-extraction" });

    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.max_tokens).toBe(256);
    expect(body.response_format).toBeUndefined();
  });

  it("adds response_format for extraction only when JSON mode is on", async () => {
    vi.stubEnv("BRAINROUTER_LLM_JSON_MODE", "on");
    const fetchMock = vi.fn().mockImplementation(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await mk().run({ prompt: "hi", taskId: "cognitive-extraction" });
    await mk().run({ prompt: "hi", taskId: "graph-extraction" });

    expect(bodyOf(fetchMock.mock.calls[0]).response_format).toEqual({ type: "json_object" });
    expect(bodyOf(fetchMock.mock.calls[1]).response_format).toBeUndefined();
  });
});

describe("ModelLLMRunner structured output (forced tool)", () => {
  const tool = {
    name: "emit",
    parameters: { type: "object", properties: { scenes: { type: "array", items: { type: "object" } } }, required: ["scenes"] },
  };

  beforeEach(() => {
    resetCognitiveBreakerForTests();
    resetSemaphoreForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetCognitiveBreakerForTests();
  });

  it("sends tools + forced tool_choice and returns the tool-call arguments", async () => {
    const args = '{"scenes":[{"scene_name":"x","memories":[]}]}';
    const fetchMock = vi.fn().mockResolvedValue(toolResponse("emit", args));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mk().run({ prompt: "hi", taskId: "cognitive-extraction", tool });

    expect(result).toBe(args); // raw tool-call arguments, not message.content
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.tools?.[0]?.function?.name).toBe("emit");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "emit" } });
  });

  it("falls back to message content when the model ignores tool_choice", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("[]"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mk().run({ prompt: "hi", taskId: "t", tool });
    expect(result).toBe("[]");
  });

  it("drops tools and retries when the backend 400s on tool_choice", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(400, "tool_choice is not supported"))
      .mockResolvedValueOnce(okResponse("[]"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mk().run({ prompt: "hi", taskId: "t", tool });

    expect(result).toBe("[]");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0]).tools).toBeDefined();    // first attempt forced the tool
    expect(bodyOf(fetchMock.mock.calls[1]).tools).toBeUndefined();  // retry dropped it
    expect(bodyOf(fetchMock.mock.calls[1]).tool_choice).toBeUndefined();
  });

  it("sends no tools when none is requested (unchanged default)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("plain"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mk().run({ prompt: "hi", taskId: "t" });
    expect(result).toBe("plain");
    expect(bodyOf(fetchMock.mock.calls[0]).tools).toBeUndefined();
  });
});

describe("cognitive circuit breaker", () => {
  beforeEach(() => {
    resetCognitiveBreakerForTests();
    resetSemaphoreForTests();
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

    await expect(mk().run({ prompt: "hi", taskId: "t" }))
      .rejects.toThrow(/circuit open/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
