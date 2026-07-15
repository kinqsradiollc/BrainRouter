/**
 * ModelGateway (ADR-014) — the SINGLE gateway every model provider routes through.
 *
 * Before this, the model callers (LLM extraction/synthesis, embedding,
 * reranker) each resolved their own DB provider and dispatched their own
 * request. This module is the one authority:
 *   - `engine.applyProviderOverrides()` registers the resolved configs here,
 *     so there is a single registry of what's routed;
 *   - `dispatch()` is the one code path that issues a chat call — honoring the
 *     provider's wire format (chat-completions or /responses), forced-tool
 *     structured output, the LM-Studio unload retry and the tool-drop fallback —
 *     which the LLM runner now delegates to (so real cognition traffic flows
 *     through the single gateway), and which any other chat caller can reuse.
 *
 * It also backs `/api/status`: `snapshot()` reports which kinds are live.
 */
import type { LLMToolSchema } from "@kinqs/brainrouter-types";
import { resolveRequestUrl, buildRequestBody, extractResponsesText, isResponsesWire } from "../../providers/wireFormat.js";
import { fetchWithExternalRetry } from "../../memory/util/retry.js";
import { requestTimeoutSignal } from "../../memory/util/request-timeout.js";
import { extractChatCompletionText } from "../../memory/llm/llm-response.js";
import { signJwt } from "../../api/auth/crypto.js";
import { MODEL_GATEWAY_AUDIENCE, MODEL_INVOKE_SCOPE } from "../gateway/auth.js";
import type { ModelReasoningEffort } from "@kinqs/brainrouter-types";
import type { ModelPolicyStore, ProviderModelRecord } from "../../providers/modelPolicyStore.js";

export type ModelKind = "llm" | "embedding" | "reranker";
export const MODEL_KINDS: ModelKind[] = ["llm", "embedding", "reranker"];

export interface GatewayProviderConfig {
  endpoint: string;
  apiKey?: string;
  model?: string;
  wireFormat?: string;
}

export interface GatewayDispatchOptions {
  endpoint: string;
  apiKey?: string;
  model: string;
  wireFormat?: string;
  messages: { role: string; content: string }[];
  tool?: LLMToolSchema;
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  label?: string;
  /** Per-call retry budget (background jobs like PR review want more headroom
   * against transient provider overload than an interactive call does). */
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
}

/**
 * Tenant-scoped internal dispatch. Unlike {@link GatewayDispatchOptions}, this
 * contract deliberately cannot carry an upstream endpoint or credential. The
 * hosted gateway resolves the public model inside the authenticated org and is
 * the only process that opens the provider secret.
 */
export interface ScopedGatewayDispatchOptions {
  orgId: string;
  servicePrincipalId: string;
  model: string;
  reasoningEffort?: string;
  messages: { role: string; content: string }[];
  tool?: LLMToolSchema;
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  label?: string;
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
}

export interface ScopedGatewayClientConfig {
  baseUrl?: string;
  jwtSecret?: string;
}

export class ScopedModelSelectionError extends Error {
  constructor(
    public readonly code: "model_not_configured" | "model_not_allowed" | "invalid_reasoning_effort",
    message: string,
  ) {
    super(message);
    this.name = "ScopedModelSelectionError";
  }
}

export interface ScopedModelSelection {
  orgId: string;
  servicePrincipalId: string;
  publicModelId: string;
  reasoningEffort?: ModelReasoningEffort;
}

/** Resolve only member-safe policy data; this path never opens provider config. */
export async function resolveScopedModelSelection(input: {
  store: ModelPolicyStore;
  orgId: string;
  requestedModel?: string;
  assignedModel?: string;
  reasoningEffort?: string;
}): Promise<ScopedModelSelection> {
  const models = await input.store.listProviderModels(input.orgId, true);
  if (models.length === 0) {
    throw new ScopedModelSelectionError(
      "model_not_configured",
      "No managed model is configured for this organization.",
    );
  }
  const byPublicId = (id: string | undefined): ProviderModelRecord | undefined => {
    const normalized = id?.trim();
    return normalized ? models.find((model) => model.publicModelId === normalized) : undefined;
  };
  const requested = input.requestedModel?.trim();
  const selected = byPublicId(requested)
    ?? byPublicId(input.assignedModel)
    ?? models.find((model) => model.isDefault)
    ?? models[0];
  if (requested && selected.publicModelId !== requested) {
    throw new ScopedModelSelectionError(
      "model_not_allowed",
      "The selected model is not enabled for this organization.",
    );
  }

  const requestedEffort = input.reasoningEffort?.trim() as ModelReasoningEffort | undefined;
  if (requestedEffort && !selected.allowedEfforts.includes(requestedEffort)) {
    throw new ScopedModelSelectionError(
      "invalid_reasoning_effort",
      "The selected reasoning effort is not allowed for this model.",
    );
  }
  const reasoningEffort = requestedEffort ?? selected.defaultEffort ?? undefined;
  const servicePrincipalId = await input.store.ensureModelGatewayServicePrincipal(input.orgId);
  return {
    orgId: input.orgId,
    servicePrincipalId,
    publicModelId: selected.publicModelId,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function hostedGatewayUrl(config?: ScopedGatewayClientConfig): string {
  return (config?.baseUrl
    ?? process.env.BRAINROUTER_MODEL_GATEWAY_URL
    ?? `http://127.0.0.1:${process.env.GATEWAY_PORT ?? "3748"}`)
    .replace(/\/+$/, "");
}

function internalJwt(opts: ScopedGatewayDispatchOptions, config?: ScopedGatewayClientConfig): string {
  const secret = config?.jwtSecret ?? process.env.BRAINROUTER_JWT_SECRET?.trim();
  if (!secret) {
    const error: Error & { code?: string } = new Error("[gateway] BRAINROUTER_JWT_SECRET is required for internal model dispatch");
    error.code = "LLM_NOT_CONFIGURED";
    throw error;
  }
  return signJwt({
    type: "service",
    aud: MODEL_GATEWAY_AUDIENCE,
    scope: [MODEL_INVOKE_SCOPE],
    servicePrincipalId: opts.servicePrincipalId,
    orgId: opts.orgId,
  }, secret, 60);
}

function scopedRequestBody(opts: ScopedGatewayDispatchOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
  };
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  if (opts.tool) {
    body.tools = [{
      type: "function",
      function: {
        name: opts.tool.name,
        description: opts.tool.description,
        parameters: opts.tool.parameters,
      },
    }];
    body.tool_choice = { type: "function", function: { name: opts.tool.name } };
  }
  return body;
}

/** One process-wide gateway. All four model kinds register + resolve through it. */
class ModelGateway {
  private readonly configs = new Map<ModelKind, GatewayProviderConfig>();
  private readonly scopedKinds = new Set<ModelKind>();

  /** Register (or clear) the resolved provider for a kind. Called by the engine. */
  configure(kind: ModelKind, cfg: GatewayProviderConfig | null): void {
    if (cfg && cfg.endpoint) this.configs.set(kind, cfg);
    else this.configs.delete(kind);
  }

  /** Status-only flag for kinds routed through the hosted, tenant-safe plane. */
  configureScoped(kind: ModelKind, configured: boolean): void {
    if (configured) this.scopedKinds.add(kind);
    else this.scopedKinds.delete(kind);
  }

  getConfig(kind: ModelKind): GatewayProviderConfig | null {
    return this.configs.get(kind) ?? null;
  }

  isConfigured(kind: ModelKind): boolean {
    return this.configs.has(kind) || this.scopedKinds.has(kind);
  }

  /** Which kinds are currently live behind the gateway (for /api/status). */
  snapshot(): Record<ModelKind, boolean> {
    return {
      llm: this.isConfigured("llm"),
      embedding: this.isConfigured("embedding"),
      reranker: this.isConfigured("reranker"),
    };
  }

  /** Dispatch a chat call for a registered kind (resolves its config, then dispatch). */
  async chat(kind: ModelKind, opts: Omit<GatewayDispatchOptions, "endpoint" | "apiKey" | "wireFormat" | "model"> & { model?: string }): Promise<string> {
    const cfg = this.configs.get(kind);
    if (!cfg?.endpoint) {
      const err: any = new Error(`[gateway] no ${kind} provider configured`);
      err.code = "LLM_NOT_CONFIGURED";
      throw err;
    }
    return this.dispatch({
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey,
      wireFormat: cfg.wireFormat,
      model: opts.model || cfg.model || "gpt-4o-mini",
      messages: opts.messages,
      tool: opts.tool,
      maxTokens: opts.maxTokens,
      jsonMode: opts.jsonMode,
      timeoutMs: opts.timeoutMs,
      label: opts.label,
      retry: opts.retry,
    });
  }

  /**
   * The single chat-dispatch path. Resolves the wire URL, builds the body (with an
   * optional forced tool for structured output), and parses the response. Handles
   * the LM-Studio "model unloaded" retry and the tool-drop fallback (some
   * OpenAI-compatible proxies reject `tools`). Returns the tool-call arguments when
   * a tool was forced + honored, else the message content.
   */
  async dispatch(opts: GatewayDispatchOptions): Promise<string> {
    const { endpoint, apiKey, model, wireFormat, messages, tool, maxTokens, jsonMode, timeoutMs, label, retry } = opts;
    const responses = isResponsesWire(wireFormat);
    const url = resolveRequestUrl(endpoint, wireFormat);
    const tag = label ?? "gateway";
    const body: Record<string, unknown> = buildRequestBody(wireFormat, { model, messages, tool, maxTokens, jsonMode });

    const doFetch = () => fetchWithExternalRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: requestTimeoutSignal(timeoutMs ?? 120_000),
    }, { label: `[${tag}] gateway chat`, ...(retry ?? {}) });

    let res = await doFetch();
    if (res.status === 400) {
      const errBody = await res.text();
      if (/model\s+(is\s+)?unloaded|model\s+not\s+loaded|no\s+models?\s+loaded/i.test(errBody)) {
        // LM-Studio JIT: the model auto-unloaded; it loads on this call, retry once.
        await new Promise((r) => setTimeout(r, 1500));
        res = await doFetch();
        if (!res.ok) throw new Error(`[${tag}] model "${model}" unloaded; retry failed (${res.status}). ${errBody}`);
      } else if (tool && body.tools) {
        // Backend rejects tools/tool_choice — drop them + retry (prompt JSON fallback).
        delete body.tools; delete body.tool_choice;
        res = await doFetch();
        if (!res.ok) throw new Error(`[${tag}] ${res.status} ${res.statusText} after dropping tools — ${await res.text()}`);
      } else {
        throw new Error(`[${tag}] ${res.status} ${res.statusText} — ${errBody}`);
      }
    } else if (!res.ok) {
      throw new Error(`[${tag}] ${res.status} ${res.statusText} — ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    if (data && typeof data === "object" && data.error) {
      const m = typeof data.error === "string" ? data.error : (data.error.message ?? JSON.stringify(data.error).slice(0, 300));
      throw new Error(`[${tag}] endpoint returned an error envelope: ${m}`);
    }
    if (responses) {
      const text = extractResponsesText(data);
      if (typeof text !== "string" || !text.trim()) throw new Error(`[${tag}] responses API returned no output: ${JSON.stringify(data).slice(0, 300)}`);
      return text;
    }
    if (!Array.isArray(data?.choices) || data.choices.length === 0) {
      throw new Error(`[${tag}] no choices for model "${model}": ${JSON.stringify(data).slice(0, 300)}`);
    }
    const choice = data.choices[0];
    if (tool) {
      const toolArgs = choice?.message?.tool_calls?.[0]?.function?.arguments;
      if (typeof toolArgs === "string" && toolArgs.trim()) return toolArgs;
    }
    const content = extractChatCompletionText(data);
    if (typeof content !== "string") throw new Error(`[${tag}] choice had no usable content: ${JSON.stringify(choice).slice(0, 300)}`);
    return content;
  }

  /**
   * Call the hosted model data plane with a short-lived, org-bound service JWT.
   * The request contains a public model id only; upstream routing and credential
   * decryption remain behind `/v1/chat/completions`.
   */
  async dispatchScoped(
    opts: ScopedGatewayDispatchOptions,
    config?: ScopedGatewayClientConfig,
  ): Promise<string> {
    const tag = opts.label ?? "gateway";
    const url = `${hostedGatewayUrl(config)}/v1/chat/completions`;
    const doFetch = () => fetchWithExternalRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${internalJwt(opts, config)}`,
        "X-BrainRouter-Org": opts.orgId,
      },
      body: JSON.stringify(scopedRequestBody(opts)),
      signal: requestTimeoutSignal(opts.timeoutMs ?? 120_000),
    }, { label: `[${tag}] internal gateway`, ...(opts.retry ?? {}) });

    const response = await doFetch();
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok) {
      const code = typeof payload?.error?.code === "string" ? payload.error.code : "gateway_error";
      const error: Error & { code?: string; status?: number } = new Error(`[${tag}] internal model gateway rejected the request (${response.status}, ${code})`);
      error.code = code;
      error.status = response.status;
      throw error;
    }
    if (!Array.isArray(payload?.choices) || payload.choices.length === 0) {
      throw new Error(`[${tag}] internal model gateway returned no choices`);
    }
    if (opts.tool) {
      const argumentsJson = payload.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
      if (typeof argumentsJson === "string" && argumentsJson.trim()) return argumentsJson;
    }
    const content = extractChatCompletionText(payload);
    if (typeof content !== "string") {
      throw new Error(`[${tag}] internal model gateway returned no usable content`);
    }
    return content;
  }
}

/** The process-wide single gateway. */
export const modelGateway = new ModelGateway();
