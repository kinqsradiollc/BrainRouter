/**
 * MC-D1 — the build-loop CRITIC: a graded "is this task actually done?" signal.
 *
 * The build loop's existing gates are binary (verify PASS/FAIL, review
 * blocker/no-blocker). The critic complements them with a probability score —
 * P(task genuinely complete) ∈ [0,1] — plus a structured diagnostic taxonomy
 * saying *why* it isn't, so a below-threshold build can be fed a targeted
 * refinement round instead of a vague "try again".
 *
 * Design invariants:
 *   - STRUCTURED output via a forced tool-call (`report_critique`), never a
 *     "respond in JSON" prose contract as the primary path. Backends that 400 on
 *     `tools`/`tool_choice` get one retry without them; the prompt carries a
 *     fenced-JSON fallback contract so the parser still has a shape to find.
 *   - Cheap tier by default: the caller resolves the LLM through the per-role
 *     model config (`agentModels.critic`, falling back like any role), with
 *     `cli.critic.model` as an explicit override.
 *   - FAIL-OPEN: an unreachable/unparseable critic returns `null` and the gate
 *     proceeds as if the critic were disabled — a scoring outage must never
 *     hold a green build hostage.
 *   - Parsing is pure and unit-tested with an injected fake LLM.
 */

import type { LLMConfig } from '../config/config.js';
import { getCliKnobs } from '../config/config.js';
import { PROVIDER_REGISTRY, findProviderByEndpoint, isLoopbackEndpoint, LOCAL_PLACEHOLDER_KEY } from '../provider/providers/index.js';
import { lastJsonBlock } from './reviewFindings.js';
import { stripTrailingSlashes } from '../util/trimEdges.js';

/** The closed diagnostic taxonomy the critic must classify its findings into. */
export const CRITIC_CATEGORIES = [
  'insufficient_testing',
  'loop_behavior',
  'unaddressed_requirement',
  'incomplete_implementation',
  'regression_risk',
  'style_only',
] as const;
export type CriticCategory = (typeof CRITIC_CATEGORIES)[number];

export interface CriticDiagnostic {
  category: CriticCategory;
  detail: string;
}

export interface CriticResult {
  /** P(task actually complete), clamped to [0,1]. */
  score: number;
  diagnostics: CriticDiagnostic[];
}

/** Everything the critic sees about the finished build attempt. */
export interface CriticInput {
  /** What was asked: the build's title/objective + the implement prompt. */
  task: string;
  /** `git diff --stat`-style summary of what the build changed. */
  diffSummary: string;
  /** The verify phase's output (test/build evidence). */
  testOutput: string;
  /** Tail of the implement phase's report (what the worker claims it did). */
  transcriptTail: string;
}

/** OpenAI-compatible function schema for the forced structured tool-call. */
export const CRITIC_TOOL = {
  name: 'report_critique',
  description:
    'Report the completion critique for a finished coding task: a 0..1 probability that the task is genuinely complete, plus structured diagnostics for anything that argues it is not.',
  parameters: {
    type: 'object',
    properties: {
      score: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'P(task actually complete). 1.0 = clearly complete and verified; 0.0 = clearly incomplete. Be skeptical: unverified claims and untested changes cap the score.',
      },
      diagnostics: {
        type: 'array',
        description: 'Concrete reasons the score is below 1.0 (empty when fully complete).',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: [...CRITIC_CATEGORIES] },
            detail: { type: 'string', description: 'One actionable sentence: what is missing/wrong and where.' },
          },
          required: ['category', 'detail'],
        },
      },
    },
    required: ['score', 'diagnostics'],
  },
} as const;

const CRITIC_SYSTEM_PROMPT = [
  'You are a strict completion critic for an autonomous coding run. You do NOT fix anything — you judge whether the task described is ACTUALLY complete based on the evidence, and report via the report_critique tool.',
  'Scoring guidance:',
  '- 0.9-1.0: implemented, verified by real test/build evidence, nothing requested is missing.',
  '- 0.6-0.8: implemented but evidence is thin (e.g. tests not covering the new behavior) or a minor requirement is unaddressed.',
  '- 0.3-0.5: partial implementation, or the transcript shows repeated non-converging attempts.',
  '- 0.0-0.2: the requested change is largely absent or the evidence contradicts the claims.',
  'Diagnostic categories: insufficient_testing (changes lack meaningful verification), loop_behavior (the run repeats itself without progress), unaddressed_requirement (something explicitly asked for is missing), incomplete_implementation (started but unfinished work, stubs, TODOs), regression_risk (evidence suggests existing behavior may break), style_only (only cosmetic concerns remain).',
  'Call the report_critique tool exactly once. If tool calls are unavailable, reply with ONLY a fenced ```json block containing {"score": <0..1>, "diagnostics": [{"category": "...", "detail": "..."}]}.',
].join('\n');

/** Keep each evidence section bounded so a cheap-tier critic never overflows. */
function tail(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length <= max ? t : `…${t.slice(t.length - max)}`;
}

/** Pure: the user message laying out the evidence for one critique call. */
export function buildCriticPrompt(input: CriticInput): string {
  return [
    '# Task',
    tail(input.task, 4_000) || '(not recorded)',
    '',
    '# Change summary (diff stat)',
    tail(input.diffSummary, 4_000) || '(no diff available)',
    '',
    '# Verification output',
    tail(input.testOutput, 6_000) || '(no verification output)',
    '',
    '# Implementation report (tail)',
    tail(input.transcriptTail, 6_000) || '(no report)',
    '',
    'Judge completion of the Task using ONLY this evidence and report via report_critique.',
  ].join('\n');
}

const isCriticCategory = (v: unknown): v is CriticCategory =>
  typeof v === 'string' && (CRITIC_CATEGORIES as readonly string[]).includes(v);

/**
 * Pure: parse a critic reply into a {@link CriticResult}, or `null` when no
 * usable shape exists (→ the gate fails open). Accepts, in order: the raw
 * tool-call `arguments` JSON, a fenced ```json block, or the first `{…}` span
 * in prose. Score is clamped to [0,1]; diagnostics outside the taxonomy or
 * without a non-empty detail are dropped (never invented).
 */
export function parseCriticOutput(raw: string): CriticResult | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const candidates: string[] = [text];
  const fenced = lastJsonBlock(text);
  if (fenced) candidates.push(fenced);
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) candidates.push(text.slice(braceStart, braceEnd + 1));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const o = parsed as Record<string, unknown>;
    const scoreRaw = typeof o.score === 'number' ? o.score : typeof o.score === 'string' ? Number(o.score) : NaN;
    if (!Number.isFinite(scoreRaw)) continue;
    const score = Math.min(1, Math.max(0, scoreRaw));
    const diagnostics: CriticDiagnostic[] = (Array.isArray(o.diagnostics) ? o.diagnostics : [])
      .map((d): CriticDiagnostic | null => {
        if (!d || typeof d !== 'object') return null;
        const rec = d as Record<string, unknown>;
        const detail = typeof rec.detail === 'string' ? rec.detail.trim() : '';
        if (!isCriticCategory(rec.category) || !detail) return null;
        return { category: rec.category, detail };
      })
      .filter((d): d is CriticDiagnostic => d !== null);
    return { score, diagnostics };
  }
  return null;
}

/**
 * A forced-tool-call schema this completion backend can drive.
 *
 * Widened from `typeof CRITIC_TOOL` for ADR-033 D5: the review reflection pass
 * needs the same transport (forced tool-call, one retry without tools, fenced
 * JSON fallback) with a different tool, and copying `makeCriticCompletion` to
 * get it would be two backends drifting apart from the first change.
 */
export interface ReviewToolSchema {
  name: string;
  description: string;
  parameters: unknown;
}

/** One critique request as handed to the completion backend (real or fake). */
export interface CriticRequest {
  system: string;
  user: string;
  tool: ReviewToolSchema;
}

/** The injectable LLM seam: returns the raw reply (tool args JSON or content). */
export type CriticCompletion = (req: CriticRequest) => Promise<string>;

/**
 * The default completion backend: one bounded chat-completions call with the
 * critique tool FORCED via `tool_choice`. A 400 (backend rejects `tools`) gets
 * one retry as a plain completion — the prompt's fenced-JSON fallback contract
 * keeps the reply parseable. Mirrors the compaction call's endpoint/key rules.
 */
export function makeCriticCompletion(llm: LLMConfig): CriticCompletion {
  return async (req) => {
    const rawEndpoint = llm.endpoint || 'https://api.openai.com/v1';
    const endpoint = stripTrailingSlashes(rawEndpoint).replace(/\/chat\/completions$/, '');
    const providerDef = findProviderByEndpoint(endpoint) ?? PROVIDER_REGISTRY.get((llm.provider ?? '').toLowerCase());
    let apiKey = llm.apiKey || '';
    const isLocal = (providerDef?.local ?? false) || isLoopbackEndpoint(endpoint);
    if (!apiKey && !isLocal && providerDef?.defaultApiKey) apiKey = providerDef.defaultApiKey;
    if (!apiKey && isLocal) apiKey = LOCAL_PLACEHOLDER_KEY;
    if (!apiKey) throw new Error('critic call failed: LLM API key is required — set it in your BrainRouter config.');

    const body: Record<string, unknown> = {
      model: llm.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      tools: [{ type: 'function', function: { name: req.tool.name, description: req.tool.description, parameters: req.tool.parameters } }],
      tool_choice: { type: 'function', function: { name: req.tool.name } },
    };

    const post = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), getCliKnobs().llmTimeoutMs);
      try {
        return await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let res = await post();
    if (res.status === 400 && body.tools) {
      // Most likely the backend rejects tools/tool_choice — retry once without
      // them; the system prompt's fenced-JSON contract is the fallback shape.
      delete body.tools;
      delete body.tool_choice;
      res = await post();
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`critic call failed: ${res.status} ${res.statusText} - ${errText.slice(0, 400)}`);
    }
    const data = (await res.json()) as any;
    const choice = data?.choices?.[0];
    const toolArgs = choice?.message?.tool_calls?.[0]?.function?.arguments;
    if (typeof toolArgs === 'string' && toolArgs.trim()) return toolArgs;
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim()) return content;
    throw new Error('critic call returned no usable reply');
  };
}

/**
 * Score one finished build attempt. Returns `null` (fail-open) when the LLM is
 * unreachable or the reply is unparseable — the caller treats that as "no
 * critic verdict", never as a failing score.
 */
export async function runCritic(
  input: CriticInput,
  opts: { llm: LLMConfig; complete?: CriticCompletion },
): Promise<CriticResult | null> {
  const complete = opts.complete ?? makeCriticCompletion(opts.llm);
  try {
    const raw = await complete({ system: CRITIC_SYSTEM_PROMPT, user: buildCriticPrompt(input), tool: CRITIC_TOOL });
    return parseCriticOutput(raw);
  } catch {
    return null;
  }
}
