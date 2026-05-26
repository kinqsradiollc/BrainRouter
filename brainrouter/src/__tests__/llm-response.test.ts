import { afterEach, describe, expect, it } from "vitest";
import { extractChatCompletionText, resolveLLMTimeoutMs, isExternalTimeoutError } from "../memory/llm-response.js";

describe("LLM response helpers", () => {
  afterEach(() => {
    delete process.env.BRAINROUTER_LLM_TIMEOUT_MS;
    delete process.env.BRAINROUTER_EXTRACTION_TIMEOUT_MS;
  });

  it("uses reasoning_content when local backends return empty message content", () => {
    const text = extractChatCompletionText({
      choices: [{
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "[{\"scene_name\":\"Local model\",\"memories\":[]}]",
        },
      }],
    });

    expect(text).toBe("[{\"scene_name\":\"Local model\",\"memories\":[]}]");
  });

  it("keeps cloud timeouts unchanged unless configured", () => {
    expect(resolveLLMTimeoutMs({
      endpoint: "https://api.openai.com/v1/chat/completions",
      requestedMs: 120_000,
    })).toBe(120_000);
  });

  it("extends local endpoint timeouts unless explicitly configured", () => {
    expect(resolveLLMTimeoutMs({
      endpoint: "http://localhost:1234/v1/chat/completions",
      requestedMs: 120_000,
    })).toBe(600_000);
  });

  it("honors task-specific timeout overrides", () => {
    process.env.BRAINROUTER_EXTRACTION_TIMEOUT_MS = "900000";

    expect(resolveLLMTimeoutMs({
      endpoint: "http://localhost:1234/v1/chat/completions",
      requestedMs: 120_000,
      envVarNames: ["BRAINROUTER_EXTRACTION_TIMEOUT_MS", "BRAINROUTER_LLM_TIMEOUT_MS"],
    })).toBe(900_000);
  });

  describe("isExternalTimeoutError", () => {
    it("returns true for direct TimeoutError", () => {
      const err = Object.assign(new Error("timed out"), { name: "TimeoutError" });
      expect(isExternalTimeoutError(err)).toBe(true);
    });

    it("returns true for direct AbortError", () => {
      const err = Object.assign(new Error("aborted"), { name: "AbortError" });
      expect(isExternalTimeoutError(err)).toBe(true);
    });

    it("returns true for undici-style DOMException wrapped in cause", () => {
      // Reproduces the user-reported failure: a top-level "fetch failed"
      // error whose cause is a DOMException("TimeoutError"). Without
      // walking .cause, this was misclassified as a generic failure and
      // dumped a full stack trace into the CLI terminal on every recall.
      const cause = Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
      const err = Object.assign(new Error("fetch failed"), { name: "TypeError", cause });
      expect(isExternalTimeoutError(err)).toBe(true);
    });

    it("returns true for message-level timeout markers", () => {
      const err = new Error("Request timed out after 600s");
      expect(isExternalTimeoutError(err)).toBe(true);
    });

    it("returns false for unrelated errors", () => {
      expect(isExternalTimeoutError(new Error("ECONNREFUSED"))).toBe(false);
      expect(isExternalTimeoutError(new Error("invalid JSON"))).toBe(false);
      expect(isExternalTimeoutError(null)).toBe(false);
      expect(isExternalTimeoutError(undefined)).toBe(false);
      expect(isExternalTimeoutError("string error")).toBe(false);
    });
  });
});
