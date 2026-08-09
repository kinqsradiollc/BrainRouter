/**
 * ADR-033 D5 — a reflection pass over the findings AS A SET, allowed to delete.
 *
 * Every bundle reviews its own files with its own context (D2), so nobody has
 * seen the review as a whole until here: the same issue reported from two
 * bundles, a finding whose evidence does not survive being read next to the
 * others, twelve nits ranked as if each were the most important thing on the
 * pull request. This pass reads the set and returns a SMALLER one.
 *
 * It must be able to return fewer findings than it received — a critic that can
 * only annotate is a formatting step. That is also why the drop verdict
 * requires a reason: a deletion we cannot explain is indistinguishable from a
 * parsing accident.
 *
 * Mechanically this is `critic.ts`'s contract reused rather than reinvented:
 * the same `CriticCompletion` seam (so the same backend, tool-forcing and
 * fenced-JSON fallback serve both), and the same FAIL-OPEN discipline —
 * an unreachable or unparseable reflection returns the findings untouched, so
 * a scoring outage can never silently empty a review.
 */
import type { CriticCompletion, ReviewToolSchema } from './critic.js';
import { lastJsonBlock, type ParsedReviewFinding } from './reviewFindings.js';

/** What the reflection may decide about one finding. */
export type ReflectionVerdictKind = 'keep' | 'drop' | 'duplicate';

export interface ReflectionVerdict {
  /** 1-based index into the findings the pass was given. */
  index: number;
  verdict: ReflectionVerdictKind;
  /** For `duplicate`: the 1-based index of the finding this one repeats. */
  duplicateOf?: number;
  /** Publication order, lowest first. Absent means "leave the order alone". */
  rank?: number;
  /** Why — required for `drop` and `duplicate`, so a deletion is explainable. */
  reason?: string;
}

export interface ReviewReflectionResult {
  findings: ParsedReviewFinding[];
  dropped: number;
  merged: number;
  /** False when the pass could not run: the findings are the input, untouched. */
  reflected: boolean;
}

/** The forced structured tool-call, mirroring `CRITIC_TOOL`'s shape. */
export const REVIEW_REFLECTION_TOOL: ReviewToolSchema = {
  name: 'report_review_reflection',
  description:
    'Judge a set of code-review findings as a whole: drop the ones that are not real, mark duplicates of each other, and rank what remains by how much it deserves a reviewer\'s attention.',
  parameters: {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        description: 'Exactly one entry per supplied finding, in any order.',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'The 1-based index of the finding.' },
            verdict: {
              type: 'string',
              enum: ['keep', 'drop', 'duplicate'],
              description:
                'keep = a real, actionable issue; drop = not real, not caused by this change, or unsupported by the evidence; duplicate = the same issue as an earlier finding.',
            },
            duplicateOf: { type: 'integer', description: 'For duplicate: the index it repeats.' },
            rank: { type: 'integer', description: 'Publication order for kept findings, 1 = first.' },
            reason: { type: 'string', description: 'One sentence. Required for drop and duplicate.' },
          },
          required: ['index', 'verdict'],
        },
      },
    },
    required: ['verdicts'],
  },
};

const REFLECTION_SYSTEM_PROMPT = [
  'You are the final gate on a code review that will be published to the pull request author.',
  'You judge the findings as a SET. You do not add findings, you do not soften them, and you do not rewrite them.',
  'We would rather MISS a real issue than publish a false one: a wrong finding costs a person\'s attention and some trust every single time, and a review people stop reading finds nothing at all.',
  'Drop a finding when: its evidence does not support the claim, it is a restatement of what the code does, it is style the project already accepts, or it is speculation about code that was not shown.',
  'Mark a finding duplicate when an earlier finding already reports the same problem, even in different words or on a neighbouring line.',
  'Rank what remains: correctness and security before clarity, and anything the author must act on before anything optional.',
  'Call the report_review_reflection tool exactly once. If tool calls are unavailable, reply with ONLY a fenced ```json block containing {"verdicts": [{"index": 1, "verdict": "keep|drop|duplicate", "duplicateOf": <index>, "rank": <n>, "reason": "..."}]}.',
].join('\n');

function clip(value: string | undefined, max: number): string {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Pure: the evidence block for one reflection call. */
export function buildReflectionPrompt(findings: readonly ParsedReviewFinding[]): string {
  const lines = findings.map((finding, index) => [
    `## Finding ${index + 1}`,
    `file: ${finding.file}${finding.line ? `:${finding.line}` : ''}`,
    `severity: ${finding.severity}${finding.preExisting ? ' (pre-existing)' : ''} · confidence: ${finding.confidence}`,
    `summary: ${clip(finding.summary, 400)}`,
    ...(finding.details ? [`details: ${clip(finding.details, 1_200)}`] : []),
    ...(finding.codeExcerpt ? [`code: ${clip(finding.codeExcerpt, 600)}`] : []),
  ].join('\n'));
  return [
    `${findings.length} finding(s) were produced by independent reviewers, each of which saw only part of the change.`,
    'Judge them as one set and report via report_review_reflection.',
    '',
    ...lines,
  ].join('\n\n');
}

function toVerdict(raw: unknown, total: number): ReflectionVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const index = Number(record.index);
  if (!Number.isInteger(index) || index < 1 || index > total) return null;
  const kind = String(record.verdict ?? '').toLowerCase();
  if (kind !== 'keep' && kind !== 'drop' && kind !== 'duplicate') return null;
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  // A deletion we cannot explain is indistinguishable from a parse accident, so
  // an unexplained drop degrades to keep rather than silently removing a finding.
  if ((kind === 'drop' || kind === 'duplicate') && !reason) return null;
  const duplicateOf = Number(record.duplicateOf);
  const rank = Number(record.rank);
  return {
    index,
    verdict: kind,
    ...(kind === 'duplicate' && Number.isInteger(duplicateOf) && duplicateOf >= 1 && duplicateOf <= total
      ? { duplicateOf }
      : {}),
    ...(Number.isInteger(rank) ? { rank } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * Pure: parse a reflection reply. Accepts the raw tool-call arguments JSON, a
 * fenced ```json block, or the first `{…}` span in prose — the same ladder
 * `parseCriticOutput` walks, for the same reason.
 */
export function parseReflectionOutput(raw: string, total: number): ReflectionVerdict[] | null {
  const text = String(raw ?? '').trim();
  if (!text || total <= 0) return null;
  const candidates: string[] = [text];
  const fenced = lastJsonBlock(text);
  if (fenced) candidates.push(fenced);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { verdicts?: unknown }).verdicts)
        ? (parsed as { verdicts: unknown[] }).verdicts
        : null;
    if (!list) continue;
    const verdicts = list
      .map((entry) => toVerdict(entry, total))
      .filter((entry): entry is ReflectionVerdict => entry !== null);
    if (verdicts.length > 0) return verdicts;
  }
  return null;
}

/**
 * Pure: apply verdicts to findings. A finding with no verdict is KEPT — the
 * pass has to say "drop" to drop something, so a truncated reply loses nothing.
 */
export function applyReflection(
  findings: readonly ParsedReviewFinding[],
  verdicts: readonly ReflectionVerdict[],
): ReviewReflectionResult {
  const byIndex = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
  const kept: Array<{ finding: ParsedReviewFinding; rank: number; order: number }> = [];
  let dropped = 0;
  let merged = 0;
  findings.forEach((finding, position) => {
    const verdict = byIndex.get(position + 1);
    if (verdict?.verdict === 'drop') {
      dropped += 1;
      return;
    }
    if (verdict?.verdict === 'duplicate') {
      merged += 1;
      return;
    }
    kept.push({
      finding,
      rank: verdict?.rank ?? Number.MAX_SAFE_INTEGER,
      order: position,
    });
  });
  kept.sort((left, right) => left.rank - right.rank || left.order - right.order);
  return { findings: kept.map((entry) => entry.finding), dropped, merged, reflected: true };
}

export interface ReflectReviewOptions {
  complete: CriticCompletion;
  /** Below this many findings the pass is skipped: nothing to judge as a set. */
  minFindings?: number;
  /** Hard ceiling on what one reflection call is shown. */
  maxFindings?: number;
}

/**
 * Reflect over a review's findings. FAIL-OPEN: any failure returns the input
 * findings with `reflected: false`, because losing a real finding to a
 * transport error is a worse outcome than publishing an unranked set.
 */
export async function reflectOnReviewFindings(
  findings: readonly ParsedReviewFinding[],
  options: ReflectReviewOptions,
): Promise<ReviewReflectionResult> {
  const minFindings = options.minFindings ?? 2;
  const maxFindings = options.maxFindings ?? 60;
  const unreflected: ReviewReflectionResult = {
    findings: [...findings],
    dropped: 0,
    merged: 0,
    reflected: false,
  };
  if (findings.length < minFindings) return unreflected;
  const considered = findings.slice(0, maxFindings);
  const remainder = findings.slice(maxFindings);
  try {
    const raw = await options.complete({
      system: REFLECTION_SYSTEM_PROMPT,
      user: buildReflectionPrompt(considered),
      tool: REVIEW_REFLECTION_TOOL,
    });
    const verdicts = parseReflectionOutput(raw, considered.length);
    if (!verdicts) return unreflected;
    const applied = applyReflection(considered, verdicts);
    return { ...applied, findings: [...applied.findings, ...remainder] };
  } catch {
    return unreflected;
  }
}
