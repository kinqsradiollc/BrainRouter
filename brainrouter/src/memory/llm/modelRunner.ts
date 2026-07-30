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
import { resolveLLMTimeoutMs, isExternalTimeoutError } from "./llm-response.js";
import { modelGateway } from "../../services/modelGateway/modelGateway.js";
import { requestTimeoutSignal } from "../util/request-timeout.js";
import { cognitiveBreakerOpen, recordCognitiveSuccess, recordCognitiveFailure } from "./cognitive-breaker.js";
import type { ModelReasoningEffort } from "@kinqs/brainrouter-types";

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
  /** Wire format: 'responses' → POST /responses; anything else → /chat/completions. */
  wireFormat?: string;
  /** Optional resilience: retry once on this model when the primary fails. */
  fallbackModel?: string;
  fallbackEndpoint?: string;
  fallbackApiKey?: string;
}

/** Public, tenant-bound gateway state. It intentionally contains no provider secret. */
export interface ScopedModelBinding {
  orgId: string;
  servicePrincipalId: string;
  publicModelId: string;
  reasoningEffort?: ModelReasoningEffort;
}

// Configurable LLM Runner — supports per-task model routing
export class ModelLLMRunner implements LLMRunner {
  private modelOverride?: string;
  private providerOverride: LlmProviderOverride | null = null;
  private scopedBinding: ScopedModelBinding | null = null;

  constructor(modelOverride?: string) {
    this.modelOverride = modelOverride?.trim() || undefined;
  }

  /**
   * Per-role model override (ADR-014 brain agent-models). The dashboard's
   * Subagents tab can route the extraction vs synthesis runner to different models
   * on the shared LLM provider. `undefined`/empty clears it (env/default applies).
   */
  setModelOverride(model?: string): void {
    this.modelOverride = model?.trim() || undefined;
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

  /** Bind this runner to one immutable organization/public-model selection. */
  setScopedBinding(binding: ScopedModelBinding | null): void {
    this.scopedBinding = binding ? { ...binding } : null;
  }

  async run({ prompt, systemPrompt, timeoutMs = 120_000, taskId, tool }: LLMRunParams): Promise<string> {
    if (this.scopedBinding) {
      return this.runScoped({ prompt, systemPrompt, timeoutMs, taskId, tool }, this.scopedBinding);
    }
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

    const wireFormat = this.providerOverride?.wireFormat;

    try {
      let result: string;
      try {
        result = await this.runOnce({ endpoint, apiKey, model, messages, effectiveTimeoutMs, taskId, tool, wireFormat });
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
          wireFormat,
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

  private async runScoped(
    params: { prompt: string; systemPrompt?: string; timeoutMs: number; taskId: string; tool?: LLMToolSchema },
    binding: ScopedModelBinding,
  ): Promise<string> {
    if (cognitiveBreakerOpen()) {
      const error: Error & { code?: string } = new Error(`[BrainRouter:${params.taskId}] cognitive LLM circuit open (provider failing); skipping this call.`);
      error.code = "COGNITIVE_BREAKER_OPEN";
      throw error;
    }
    const messages: { role: string; content: string }[] = [];
    if (params.systemPrompt) messages.push({ role: "system", content: params.systemPrompt });
    messages.push({ role: "user", content: params.prompt });
    const effectiveTimeoutMs = resolveLLMTimeoutMs({
      endpoint: process.env.BRAINROUTER_MODEL_GATEWAY_URL ?? "http://127.0.0.1:3748/v1/chat/completions",
      requestedMs: params.timeoutMs,
      envVarNames: params.taskId === "cognitive-extraction"
        ? ["BRAINROUTER_EXTRACTION_TIMEOUT_MS", "BRAINROUTER_LLM_TIMEOUT_MS"]
        : ["BRAINROUTER_LLM_TIMEOUT_MS"],
    });
    const maxTokens = parsePositiveInt(process.env.BRAINROUTER_LLM_MAX_TOKENS);
    const jsonMode = process.env.BRAINROUTER_LLM_JSON_MODE === "on" && params.taskId === "cognitive-extraction";
    const retry = params.taskId.startsWith("pr-")
      ? { maxRetries: 6, baseDelayMs: 3_000, maxDelayMs: 45_000 }
      : undefined;
    const release = await acquireLLMSlot();
    try {
      const result = await modelGateway.dispatchScoped({
        orgId: binding.orgId,
        servicePrincipalId: binding.servicePrincipalId,
        model: binding.publicModelId,
        reasoningEffort: binding.reasoningEffort,
        messages,
        tool: params.tool,
        maxTokens,
        jsonMode,
        timeoutMs: effectiveTimeoutMs,
        label: `BrainRouter:${params.taskId}`,
        retry,
      });
      recordCognitiveSuccess();
      return result;
    } catch (error) {
      recordCognitiveFailure();
      throw error;
    } finally {
      release();
    }
  }

  // One attempt against one model/endpoint. Owns the LLM semaphore slot; the actual
  // dispatch — wire-format resolution, structured-output tool, LM-Studio unload +
  // tool-drop retries, response parse — runs through the single ModelGateway, so all
  // LLM cognition traffic routes through the one gateway.
  private async runOnce(args: {
    endpoint: string;
    apiKey: string;
    model: string;
    messages: { role: string; content: string }[];
    effectiveTimeoutMs: number;
    taskId: string;
    tool?: LLMToolSchema;
    wireFormat?: string;
  }): Promise<string> {
    const { endpoint, apiKey, model, messages, effectiveTimeoutMs, taskId, tool, wireFormat } = args;
    const maxTokens = parsePositiveInt(process.env.BRAINROUTER_LLM_MAX_TOKENS);
    const jsonMode = process.env.BRAINROUTER_LLM_JSON_MODE === "on" && taskId === "cognitive-extraction";
    // Acquire an LLM semaphore slot BEFORE dispatch (consumer-GPU thrash guard —
    // see llm-semaphore.ts); release in finally so the queue keeps moving on throw.
    // PR-review jobs run in the background off a webhook, and a single PR event can
    // fan out several large-diff reviews at once (security + code-review lenses, on
    // multiple PRs). Give them a more generous retry budget so a transient provider
    // 429/503 recovers within the job instead of exhausting the default budget and
    // silently dropping the review. Interactive cognition keeps the default.
    const retry = taskId.startsWith("pr-") ? { maxRetries: 6, baseDelayMs: 3_000, maxDelayMs: 45_000 } : undefined;
    const release = await acquireLLMSlot();
    try {
      return await modelGateway.dispatch({
        endpoint, apiKey, model, wireFormat, messages, tool, maxTokens, jsonMode,
        timeoutMs: effectiveTimeoutMs, label: `BrainRouter:${taskId}`, retry,
      });
    } finally {
      release();
    }
  }
}
