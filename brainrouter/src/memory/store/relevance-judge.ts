import type { RelevanceJudgeServiceConfig, RelevanceVerdict } from "@kinqs/brainrouter-types";
import { acquireLLMSlot } from "../llm/llm-semaphore.js";
import { resolveLLMTimeoutMs } from "../llm/llm-response.js";
import { normalizeRequestTimeoutMs } from "../util/request-timeout.js";
import { extractJsonValue } from "../util/llm-json.js";
import { modelGateway } from "../../services/modelGateway/modelGateway.js";

export interface JudgeCandidate {
  /** Stable id used for logging — typically the memory's record_id. */
  id: string;
  /** Memory content the judge will read. */
  content: string;
}

export interface JudgeResult {
  /** Verdicts in the order returned by the judge. */
  verdicts: RelevanceVerdict[];
  /** Indices the judge approved as relevant. */
  approvedIndices: number[];
}

/**
 * MEM-JUDGE2 (0.4.14) — characters of each candidate shown to the judge. The old
 * hardcoded 600 showed only ~40% of a 1500-char (MEM-CHUNK) chunk, so the judge
 * rejected answers it literally never saw — a major source of the recall
 * collapse on long records. Default 1200; clamp [200, 4000].
 *   BRAINROUTER_RELEVANCE_JUDGE_DOC_CHARS
 */
export function judgeDocChars(env: NodeJS.ProcessEnv = process.env): number {
  const def = 1200;
  const raw = env.BRAINROUTER_RELEVANCE_JUDGE_DOC_CHARS;
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 200 ? Math.min(n, 4000) : def;
}

/**
 * LLM-as-judge stage that approves or rejects retrieved memories based on
 * actual semantic relevance to the user query — sits between the reranker and
 * context formatting, dropping candidates that share keywords but aren't
 * genuinely about the query subject.
 *
 * Failure mode is "skip the gate": if the call errors out, callers fall back
 * to the unfiltered reranker output. We never want a flaky judge call to
 * crash a recall.
 */
export class RelevanceJudgeService {
  private readonly enabled: boolean;
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private readonly maxCandidates: number;
  private readonly timeoutMs: number;
  private ready: boolean;

  constructor(config: RelevanceJudgeServiceConfig) {
    this.enabled = config.enabled ?? false;
    this.endpoint = config.endpoint ?? "https://api.openai.com/v1/chat/completions";
    this.apiKey = config.apiKey ?? "";
    this.model = config.model ?? "gpt-4o-mini";
    this.maxCandidates = Math.max(1, config.maxCandidates ?? 10);
    // 0 = no timeout: wait for the judge LLM (see request-timeout.ts). A bound is
    // opt-in via BRAINROUTER_RELEVANCE_JUDGE_TIMEOUT_MS / BRAINROUTER_LLM_TIMEOUT_MS.
    this.timeoutMs = normalizeRequestTimeoutMs(config.timeoutMs ?? resolveLLMTimeoutMs({
      endpoint: this.endpoint,
      requestedMs: 0,
      envVarNames: ["BRAINROUTER_RELEVANCE_JUDGE_TIMEOUT_MS", "BRAINROUTER_LLM_TIMEOUT_MS"],
    }));

    this.ready = this.enabled && !!this.apiKey;
    if (this.enabled && !this.apiKey) {
      console.error("[BrainRouter] Relevance judge enabled but no API key set. Stage 4 judging will be skipped.");
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /** ADR-010 P2 — apply a DB-resolved provider (endpoint/apiKey/model); readiness
   *  still requires the judge to be enabled. */
  reconfigure(cfg: { endpoint?: string; apiKey?: string; model?: string }): void {
    if (cfg.endpoint) this.endpoint = cfg.endpoint;
    if (cfg.apiKey) this.apiKey = cfg.apiKey;
    if (cfg.model) this.model = cfg.model;
    this.ready = this.enabled && !!this.apiKey;
  }

  getMaxCandidates(): number {
    return this.maxCandidates;
  }

  /**
   * Grade a batch of candidates against the query. Returns verdicts and the
   * subset of indices approved as relevant. Throws on transport/parsing
   * failure — callers are expected to fall back to pre-judge results.
   */
  async judge(params: { query: string; candidates: JudgeCandidate[] }): Promise<JudgeResult> {
    if (!this.ready) {
      throw new Error("RelevanceJudgeService is not ready (disabled or missing API key)");
    }
    if (params.candidates.length === 0) {
      return { verdicts: [], approvedIndices: [] };
    }

    const candidates = params.candidates.slice(0, this.maxCandidates);
    const maxDocChars = judgeDocChars();
    const safeQuery = params.query.length > 800 ? params.query.slice(0, 800) + "…" : params.query;
    const candidateBlock = candidates
      .map((c, i) => {
        const text = c.content.length > maxDocChars ? c.content.slice(0, maxDocChars) + "…" : c.content;
        return `[${i}] ${text.replace(/\s+/g, " ").trim()}`;
      })
      .join("\n");

    const systemPrompt = [
      "You are a strict relevance judge for a memory retrieval system.",
      "For each candidate memory, decide whether it is actually relevant to the user's query.",
      "A memory is RELEVANT only if it provides information that directly helps answer, contextualize, or inform the query.",
      "It is NOT relevant if it merely shares keywords, is about a different subject, or is generic background.",
      "When in doubt, reject — false positives pollute the agent's context window.",
      "Respond with strict JSON only, no prose.",
    ].join(" ");

    const userPrompt = [
      `Query: ${safeQuery}`,
      "",
      "Candidates:",
      candidateBlock,
      "",
      "Respond with exactly this JSON shape:",
      `{"verdicts":[{"index":0,"relevant":true,"reason":"…"}, …]}`,
      "Include one verdict per candidate. Keep each reason under 120 chars.",
    ].join("\n");

    // The judge is just another LLM call (like the desktop/CLI agent), so it routes
    // through the single ModelGateway using the configured LLM provider. The gateway
    // owns the wire format, the forced-tool structured output (schema'd so the shape
    // is consistent across models), the LM-Studio unload retry and the tool-drop
    // fallback — no more duplicated transport here.
    const release = await acquireLLMSlot();
    let raw: string;
    try {
      raw = await modelGateway.dispatch({
        endpoint: this.endpoint,
        apiKey: this.apiKey,
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tool: {
          name: "report_relevance",
          description: "Return one relevance verdict per candidate, as described in the prompt.",
          parameters: {
            type: "object",
            properties: { verdicts: { type: "array", items: { type: "object" } } },
            required: ["verdicts"],
            additionalProperties: false,
          },
        },
        timeoutMs: this.timeoutMs,
        label: "Relevance Judge",
      });
    } finally {
      release();
    }

    const parsed = this.parseVerdicts(raw, candidates.length);

    const approvedIndices: number[] = [];
    for (const v of parsed) {
      if (v.relevant && v.index >= 0 && v.index < candidates.length) {
        approvedIndices.push(v.index);
      }
    }

    return { verdicts: parsed, approvedIndices };
  }

  /**
   * Defensive JSON parse — strips code fences, picks the first valid JSON
   * object/array, and tolerates either {"verdicts":[…]} or a bare array.
   * Returns one verdict per candidate; missing entries default to "rejected"
   * so a malformed response can't silently approve everything.
   */
  private parseVerdicts(raw: string, candidateCount: number): RelevanceVerdict[] {
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

    // Robust parse: balanced-span scan + repair, tolerant of role-token leaks,
    // prose, and trailing commas (see llm-json.ts). `text` is already de-fenced.
    const parsed: any = extractJsonValue(text, { kind: "any" });
    if (parsed === null) {
      throw new Error(`Relevance Judge produced non-JSON output: ${text.slice(0, 200)}`);
    }

    const list: any[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];

    const byIndex = new Map<number, RelevanceVerdict>();
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const index = Number(item.index);
      if (!Number.isFinite(index)) continue;
      byIndex.set(index, {
        index,
        relevant: Boolean(item.relevant),
        reason: typeof item.reason === "string" ? item.reason.slice(0, 200) : "",
      });
    }

    const out: RelevanceVerdict[] = [];
    for (let i = 0; i < candidateCount; i++) {
      out.push(byIndex.get(i) ?? { index: i, relevant: false, reason: "no verdict returned" });
    }
    return out;
  }
}
