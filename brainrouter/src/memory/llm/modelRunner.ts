/**
 * ADR-004 Phase 4 — the backend's OpenAI-compatible LLM runner.
 *
 * Extracted VERBATIM from `engine.ts`, where it sat above `MemoryEngine` as an
 * embedded concern. It implements `LLMRunner` (the port the capture/recall
 * pipelines depend on) over a configurable OpenAI-compatible chat-completions
 * endpoint, with the global LLM semaphore + LM-Studio unload-retry handling.
 * Pulling it out lets `engine.ts` read as a memory facade, and gives Phase 5 a
 * single seam to de-duplicate against `@kinqs/brainrouter-core`'s runner.
 *
 * Behaviour is unchanged — including the `BRAINROUTER_LLM_*` env configuration,
 * which is the backend server's existing deployment contract.
 */

import type { LLMRunner, LLMRunParams } from "@kinqs/brainrouter-types";
import { fetchWithExternalRetry } from "../util/retry.js";
import { acquireLLMSlot } from "./llm-semaphore.js";
import { extractChatCompletionText, resolveLLMTimeoutMs } from "./llm-response.js";

// Configurable LLM Runner — supports per-task model routing
export class ModelLLMRunner implements LLMRunner {
  private readonly modelOverride?: string;

  constructor(modelOverride?: string) {
    this.modelOverride = modelOverride?.trim() || undefined;
  }

  async run({ prompt, systemPrompt, timeoutMs = 120_000, taskId }: LLMRunParams): Promise<string> {
    const endpoint = process.env.BRAINROUTER_LLM_ENDPOINT ?? "https://api.openai.com/v1/chat/completions";
    const apiKey = process.env.BRAINROUTER_LLM_API_KEY;

    if (!apiKey) {
      // Typed sentinel so upstream pipelines can short-circuit cleanly without dumping a stack trace.
      // Callers should check `error.code === "LLM_NOT_CONFIGURED"` and skip extraction silently.
      const err: any = new Error(`[BrainRouter:${taskId}] BRAINROUTER_LLM_API_KEY is not set. Skipping LLM step.`);
      err.code = "LLM_NOT_CONFIGURED";
      throw err;
    }

    const model = this.modelOverride
      ?? (process.env.BRAINROUTER_LLM_MODEL?.trim() || undefined)
      ?? "gpt-4o-mini";

    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const effectiveTimeoutMs = resolveLLMTimeoutMs({
      endpoint,
      requestedMs: timeoutMs,
      envVarNames: taskId === "cognitive-extraction"
        ? ["BRAINROUTER_EXTRACTION_TIMEOUT_MS", "BRAINROUTER_LLM_TIMEOUT_MS"]
        : ["BRAINROUTER_LLM_TIMEOUT_MS"],
    });

    const doFetch = () => fetchWithExternalRetry(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(effectiveTimeoutMs),
    }, {
      label: `[BrainRouter:${taskId}] LLM API`,
    });

    // Acquire a slot from the global LLM semaphore BEFORE issuing the
    // request. On consumer hardware (LM Studio with a single GPU) firing
    // more than ~2 concurrent generations against the same backend causes
    // the model to thrash or auto-unload — see llm-semaphore.ts for the
    // full rationale. Cloud backends (OpenAI / OpenRouter) can lift the cap
    // with BRAINROUTER_LLM_MAX_CONCURRENT=10 (or higher).
    const release = await acquireLLMSlot();
    try {
      let res = await doFetch();

      // LM Studio quirk: if the model has been idle long enough to auto-unload,
      // it returns 400 with `{"error":"Model is unloaded."}` on the first call
      // and then loads the model in the background. The next call usually
      // succeeds. Detect that exact error and retry ONCE after a brief pause
      // so background workers (contradiction check, graph extraction, focus
      // shift detection) don't all fail when the user has been quiet for a bit.
      if (res.status === 400) {
        const errorBody = await res.text();
        if (/model\s+(is\s+)?unloaded|model\s+not\s+loaded|no\s+models?\s+loaded/i.test(errorBody)) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          res = await doFetch();
          if (!res.ok) {
            const retryBody = await res.text();
            throw new Error(
              `[BrainRouter:${taskId}] LLM model "${model}" was unloaded by the server; ` +
              `retry also failed (${res.status} ${res.statusText}). ` +
              `If you're using LM Studio, enable JIT model loading or pin the model as always-loaded. ` +
              `Original error: ${errorBody}. Retry error: ${retryBody}`,
            );
          }
        } else {
          throw new Error(`[BrainRouter:${taskId}] LLM Error (${model}): ${res.status} ${res.statusText} - ${errorBody}`);
        }
      } else if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`[BrainRouter:${taskId}] LLM Error (${model}): ${res.status} ${res.statusText} - ${errorBody}`);
      }

      const data = await res.json() as any;
      // Defensive parsing — see brainrouter/src/agent/agent.ts callOpenAI for the
      // full rationale. The short version: some endpoints return HTTP 200
      // with an `error` envelope or a non-standard schema. Surface the
      // actual response body in the error so a misconfigured model name
      // doesn't crash with "Cannot read properties of undefined".
      if (data && typeof data === "object" && data.error) {
        const errMsg = typeof data.error === "string"
          ? data.error
          : (data.error.message ?? JSON.stringify(data.error).slice(0, 400));
        throw new Error(`[BrainRouter:${taskId}] LLM endpoint returned an error envelope: ${errMsg}`);
      }
      if (!Array.isArray(data?.choices) || data.choices.length === 0) {
        throw new Error(
          `[BrainRouter:${taskId}] LLM endpoint returned no choices for model "${model}". ` +
          `Response body: ${JSON.stringify(data).slice(0, 600)}`,
        );
      }
      // Tolerate standard, streaming-style, and reasoning-model shapes. Some
      // local OpenAI-compatible backends return an empty message.content with
      // useful output in reasoning_content.
      const choice = data.choices[0];
      const content = extractChatCompletionText(data);
      if (typeof content !== "string") {
        throw new Error(
          `[BrainRouter:${taskId}] LLM choice had no usable content. Choice: ${JSON.stringify(choice).slice(0, 600)}`,
        );
      }
      return content;
    } finally {
      // Always release, success or failure, so the queue keeps moving even
      // if an upstream throw bubbles. The semaphore's release is idempotent.
      release();
    }
  }
}
