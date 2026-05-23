import type { RelevanceJudgeServiceConfig, RelevanceVerdict } from "@kinqs/brainrouter-types";
import { fetchWithExternalRetry } from "../retry.js";
import { acquireLLMSlot } from "../llm-semaphore.js";

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
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxCandidates: number;
  private readonly timeoutMs: number;
  private readonly ready: boolean;

  constructor(config: RelevanceJudgeServiceConfig) {
    this.enabled = config.enabled ?? false;
    this.endpoint = config.endpoint ?? "https://api.openai.com/v1/chat/completions";
    this.apiKey = config.apiKey ?? "";
    this.model = config.model ?? "gpt-4o-mini";
    this.maxCandidates = Math.max(1, config.maxCandidates ?? 10);
    this.timeoutMs = Math.max(1000, config.timeoutMs ?? 15_000);

    this.ready = this.enabled && !!this.apiKey;
    if (this.enabled && !this.apiKey) {
      console.error("[BrainRouter] Relevance judge enabled but no API key set. Stage 4 judging will be skipped.");
    }
  }

  isReady(): boolean {
    return this.ready;
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
    const safeQuery = params.query.length > 800 ? params.query.slice(0, 800) + "…" : params.query;
    const candidateBlock = candidates
      .map((c, i) => {
        const text = c.content.length > 600 ? c.content.slice(0, 600) + "…" : c.content;
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

    const doFetch = () => fetchWithExternalRetry(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      // Deliberately omitting `response_format` — OpenAI accepts
      // `{type:"json_object"}`, but LM Studio / llama.cpp-style backends
      // reject anything except `json_schema` or `text` with a 400, and
      // Ollama / vLLM each have their own quirks. The system prompt is
      // explicit about strict-JSON output and the parser below strips
      // code fences + tolerates surrounding prose, so dropping the hint
      // is cheaper than per-provider branching.
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }, {
      label: "Relevance Judge API",
    });

    const release = await acquireLLMSlot();
    let raw: string;
    try {
      let res = await doFetch();
      // LM Studio quirk: idle models auto-unload and the first call after
      // unload returns 400 with "Model is unloaded" / "No models loaded".
      // The backend then loads the model in the background, so a retry
      // ~1.5s later usually succeeds. Mirrors ModelLLMRunner in engine.ts.
      if (res.status === 400) {
        const errorBody = await res.text();
        if (/model\s+(is\s+)?unloaded|model\s+not\s+loaded|no\s+models?\s+loaded/i.test(errorBody)) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          res = await doFetch();
          if (!res.ok) {
            const retryBody = await res.text().catch(() => "(no body)");
            throw new Error(
              `Relevance Judge API failed after LM Studio reload retry: HTTP ${res.status} ${res.statusText} - ${retryBody}`,
            );
          }
        } else {
          throw new Error(`Relevance Judge API failed: HTTP ${res.status} ${res.statusText} - ${errorBody}`);
        }
      } else if (!res.ok) {
        const err = await res.text().catch(() => "(no body)");
        throw new Error(`Relevance Judge API failed: HTTP ${res.status} ${res.statusText} - ${err}`);
      }
      const data = await res.json() as any;
      if (data?.error) {
        const errMsg = typeof data.error === "string" ? data.error : (data.error.message ?? JSON.stringify(data.error).slice(0, 400));
        throw new Error(`Relevance Judge endpoint returned an error envelope: ${errMsg}`);
      }
      const choice = data?.choices?.[0];
      const content = choice?.message?.content ?? choice?.delta?.content;
      if (typeof content !== "string") {
        throw new Error(`Relevance Judge returned no usable content. Response: ${JSON.stringify(data).slice(0, 400)}`);
      }
      raw = content;
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

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      const objMatch = text.match(/\{[\s\S]*\}/);
      const arrMatch = text.match(/\[[\s\S]*\]/);
      const candidate = objMatch?.[0] ?? arrMatch?.[0];
      if (!candidate) {
        throw new Error(`Relevance Judge produced non-JSON output: ${text.slice(0, 200)}`);
      }
      parsed = JSON.parse(candidate);
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
