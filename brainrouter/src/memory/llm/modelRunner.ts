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

import type { LLMRunner, LLMRunParams, LLMToolSchema } from "@kinqs/brainrouter-types";
import { fetchWithExternalRetry, ExternalApiError } from "../util/retry.js";
import { acquireLLMSlot } from "./llm-semaphore.js";
import { extractChatCompletionText, resolveLLMTimeoutMs, isExternalTimeoutError } from "./llm-response.js";
import { requestTimeoutSignal } from "../util/request-timeout.js";
import { cognitiveBreakerOpen, recordCognitiveSuccess, recordCognitiveFailure } from "./cognitive-breaker.js";

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// Decide whether a failed primary call should retry on the fallback model.
// True for provider/transport failures (timeouts, network blips, 5xx/429 left
// after the built-in retries); false for client errors (4xx) or a missing API
// key, which a different model won't fix.
function shouldFallback(err: unknown): boolean {
  if (isExternalTimeoutError(err)) return true;
  if (err instanceof TypeError) return true; // low-level fetch/network failure
  if (err instanceof ExternalApiError) {
    return err.status === undefined ? true : [429, 500, 502, 503, 504].includes(err.status);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504)\b/.test(msg);
}

/** ADR-012 — the DB-resolved LLM provider the runner uses (no more `.env`). */
export interface LlmProviderOverride {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  /** Optional resilience: retry once on this model when the primary fails. */
  fallbackModel?: string;
  fallbackEndpoint?: string;
  fallbackApiKey?: string;
}

// Configurable LLM Runner — supports per-task model routing
export class ModelLLMRunner implements LLMRunner {
  private readonly modelOverride?: string;
  private providerOverride: LlmProviderOverride | null = null;

  constructor(modelOverride?: string) {
    this.modelOverride = modelOverride?.trim() || undefined;
  }

  /**
   * ADR-012 — set the DB-resolved LLM provider (endpoint/apiKey/model + optional
   * fallback). This is the ONLY source of the runner's credentials now; `null`
   * clears it → the runner is unconfigured (cognition is skipped) until an admin
   * configures a provider in the DB / dashboard.
   */
  setProviderOverride(o: LlmProviderOverride | null): void {
    this.providerOverride = o && (o.endpoint || o.apiKey || o.model) ? o : null;
  }

  async run({ prompt, systemPrompt, timeoutMs = 120_000, taskId, tool }: LLMRunParams): Promise<string> {
    const endpoint = this.providerOverride?.endpoint || "https://api.openai.com/v1/chat/completions";
    const apiKey = this.providerOverride?.apiKey;

    if (!apiKey) {
      // Typed sentinel so upstream pipelines can short-circuit cleanly without dumping a stack trace.
      // Callers should check `error.code === "LLM_NOT_CONFIGURED"` and skip extraction silently.
      // Thrown BEFORE the breaker so a config gap never counts as a provider failure.
      const err: any = new Error(`[BrainRouter:${taskId}] no LLM provider is configured (add one in the dashboard → AI Providers). Skipping LLM step.`);
      err.code = "LLM_NOT_CONFIGURED";
      throw err;
    }

    // Fast-fail when the generative provider is currently failing, so a single
    // turn's cognitive chain (extraction + contradiction + graph + focus +
    // distill) doesn't each burn full retry+timeout against a dead endpoint.
    // Records stay queued; the sweeper retries after the cooldown.
    if (cognitiveBreakerOpen()) {
      const err: any = new Error(`[BrainRouter:${taskId}] cognitive LLM circuit open (provider failing); skipping this call.`);
      err.code = "COGNITIVE_BREAKER_OPEN";
      throw err;
    }

    const model = this.modelOverride
      ?? this.providerOverride?.model
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

    const fallbackModelName = this.providerOverride?.fallbackModel?.trim() || undefined;

    try {
      let result: string;
      try {
        result = await this.runOnce({ endpoint, apiKey, model, messages, effectiveTimeoutMs, taskId, tool });
      } catch (err) {
        // On a provider/transport failure, retry ONCE against a stable fallback
        // model before giving up. No-op (rethrow) when no fallback is configured
        // on the provider, it equals the primary, or the error is a client error.
        if (!fallbackModelName || fallbackModelName === model || !shouldFallback(err)) {
          throw err;
        }
        const fbEndpoint = this.providerOverride?.fallbackEndpoint?.trim() || endpoint;
        const fbApiKey = this.providerOverride?.fallbackApiKey?.trim() || apiKey;
        console.warn(
          `[BrainRouter:${taskId}] primary model "${model}" failed (${err instanceof Error ? err.message : String(err)}); `
          + `retrying once on fallback model "${fallbackModelName}".`,
        );
        result = await this.runOnce({
          endpoint: fbEndpoint,
          apiKey: fbApiKey,
          model: fallbackModelName,
          messages,
          effectiveTimeoutMs,
          taskId,
          tool,
        });
      }
      recordCognitiveSuccess();
      return result;
    } catch (err) {
      // Both the primary and the fallback (if any) failed — count it toward the
      // breaker so a sustained outage opens the circuit.
      recordCognitiveFailure();
      throw err;
    }
  }

  // One attempt against one model/endpoint. Owns the semaphore slot and the
  // LM-Studio unload retry so the fallback path can re-run it cleanly without
  // leaking a slot or losing the unload handling.
  private async runOnce(args: {
    endpoint: string;
    apiKey: string;
    model: string;
    messages: { role: string; content: string }[];
    effectiveTimeoutMs: number;
    taskId: string;
    tool?: LLMToolSchema;
  }): Promise<string> {
    const { endpoint, apiKey, model, messages, effectiveTimeoutMs, taskId, tool } = args;

    const body: Record<string, unknown> = { model, messages };
    const maxTokens = parsePositiveInt(process.env.BRAINROUTER_LLM_MAX_TOKENS);
    if (maxTokens) {
      body.max_tokens = maxTokens;
    }
    // STRUCTURED OUTPUT — force the model to return its result as a function call
    // whose schema fixes the shape, instead of relying on a "respond in JSON"
    // prompt that drifts across model versions. Backends that don't support
    // tool-calling 400 here and we transparently retry without it (below), so
    // the prompt's JSON instruction remains the compatibility fallback.
    if (tool) {
      body.tools = [{ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters } }];
      body.tool_choice = { type: "function", function: { name: tool.name } };
    }
    // Opt-in JSON mode, extraction only. OFF by default: some OpenAI-compatible
    // proxies (incl. the free nemotron endpoint) 400 on an unknown
    // `response_format`, and json_object forces a top-level object while
    // extraction expects an array. Enable only against a backend known to honour it.
    if (process.env.BRAINROUTER_LLM_JSON_MODE === "on" && taskId === "cognitive-extraction") {
      body.response_format = { type: "json_object" };
    }

    const doFetch = () => fetchWithExternalRetry(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: requestTimeoutSignal(effectiveTimeoutMs),
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
        } else if (tool && body.tools) {
          // The 400 most likely means this backend rejects `tools`/`tool_choice`
          // (some OpenAI-compatible proxies do). Drop the forced tool and retry
          // once as a plain completion — the prompt still carries the JSON
          // instruction, so the caller's JSON chokepoint handles the content.
          delete body.tools;
          delete body.tool_choice;
          res = await doFetch();
          if (!res.ok) {
            const retryBody = await res.text();
            throw new Error(`[BrainRouter:${taskId}] LLM Error (${model}) after dropping tool_choice: ${res.status} ${res.statusText} - ${retryBody}`);
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
      // STRUCTURED OUTPUT — when we forced a tool, the result is the tool-call's
      // JSON `arguments` (schema-shaped, consistent across models). Prefer it.
      // If the model ignored tool_choice and replied in content instead, fall
      // through to the normal content extraction below.
      if (tool) {
        const toolArgs = choice?.message?.tool_calls?.[0]?.function?.arguments;
        if (typeof toolArgs === "string" && toolArgs.trim()) return toolArgs;
      }
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
