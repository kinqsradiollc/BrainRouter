/**
 * ModelGateway (ADR-014) — the SINGLE gateway every model provider routes through.
 *
 * Before this, the four model callers (LLM extraction/synthesis, embedding,
 * reranker, judge) each resolved their own DB provider and dispatched their own
 * request. This module is the one authority:
 *   - `engine.applyProviderOverrides()` registers all four resolved configs here,
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

export type ModelKind = "llm" | "embedding" | "reranker" | "judge";
export const MODEL_KINDS: ModelKind[] = ["llm", "embedding", "reranker", "judge"];

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
}

/** One process-wide gateway. All four model kinds register + resolve through it. */
class ModelGateway {
  private readonly configs = new Map<ModelKind, GatewayProviderConfig>();

  /** Register (or clear) the resolved provider for a kind. Called by the engine. */
  configure(kind: ModelKind, cfg: GatewayProviderConfig | null): void {
    if (cfg && cfg.endpoint) this.configs.set(kind, cfg);
    else this.configs.delete(kind);
  }

  getConfig(kind: ModelKind): GatewayProviderConfig | null {
    return this.configs.get(kind) ?? null;
  }

  isConfigured(kind: ModelKind): boolean {
    return this.configs.has(kind);
  }

  /** Which kinds are currently live behind the gateway (for /api/status). */
  snapshot(): Record<ModelKind, boolean> {
    return {
      llm: this.configs.has("llm"),
      embedding: this.configs.has("embedding"),
      reranker: this.configs.has("reranker"),
      judge: this.configs.has("judge"),
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
    const { endpoint, apiKey, model, wireFormat, messages, tool, maxTokens, jsonMode, timeoutMs, label } = opts;
    const responses = isResponsesWire(wireFormat);
    const url = resolveRequestUrl(endpoint, wireFormat);
    const tag = label ?? "gateway";
    const body: Record<string, unknown> = buildRequestBody(wireFormat, { model, messages, tool, maxTokens, jsonMode });

    const doFetch = () => fetchWithExternalRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: requestTimeoutSignal(timeoutMs ?? 120_000),
    }, { label: `[${tag}] gateway chat` });

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
}

/** The process-wide single gateway. */
export const modelGateway = new ModelGateway();
