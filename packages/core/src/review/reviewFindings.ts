/**
 * T12 / Review v2 — parse a single review agent turn's output into structured
 * findings rich enough to render a real PR-style review: not just a summary, but
 * the affected file + line range, why it's a real issue, the suggested fix, a
 * verbatim code excerpt / mini diff hunk, and (when safe) a git-apply-able patch.
 * The reviewer is asked to end with a fenced ```json array (REVIEW_OUTPUT_CONTRACT);
 * this extracts + validates it, tolerating prose around it and a missing/malformed
 * block (→ []). Pure + unit-tested; the host maps these onto the stored ReviewFinding.
 */

/** Everything the reviewer can give us about one finding (pre-store: no id/status). */
export interface ParsedReviewFinding {
  file: string;
  line?: number;
  endLine?: number;
  severity: string;
  confidence: number;
  summary: string;
  details?: string;
  suggestion?: string;
  /** A few verbatim lines of the affected code, for in-panel context. */
  codeExcerpt?: string;
  /** An optional unified-diff hunk (problem `-` lines + suggested `+` lines). */
  diffHunk?: string;
  /** An optional FULL unified diff, git-apply-able, when the fix is small + safe. */
  patch?: string;
}

// Accept both the v2 scale and the older free-form words (the host normalizes).
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info', 'bug', 'security', 'perf', 'style', 'nit', 'warn']);

/** Extract the LAST fenced ```json block from a markdown string, or null. */
export function lastJsonBlock(text: string): string | null {
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1].trim();
  return last;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);

/** Coerce one raw object into a ParsedReviewFinding (dropping anything unusable). */
function coerce(raw: unknown): ParsedReviewFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const file = str(o.file)?.trim();
  const summary = (str(o.summary) ?? str(o.message))?.trim();
  if (!file || !summary) return null;
  const sevRaw = typeof o.severity === 'string' ? o.severity.toLowerCase().trim() : 'info';
  return {
    file,
    line: num(o.line),
    endLine: num(o.endLine),
    severity: SEVERITIES.has(sevRaw) ? sevRaw : 'info',
    confidence: typeof o.confidence === 'number' ? Math.max(0, Math.min(100, o.confidence)) : 70,
    summary,
    details: str(o.details),
    suggestion: str(o.suggestion),
    codeExcerpt: str(o.codeExcerpt) ?? str(o.excerpt),
    diffHunk: str(o.diffHunk) ?? str(o.hunk),
    patch: str(o.patch),
  };
}

export function parseReviewFindings(text: string): ParsedReviewFinding[] {
  const block = lastJsonBlock(text);
  if (!block) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(block); } catch { return []; }
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)
        ? (parsed as { findings: unknown[] }).findings : []);
  return arr.map(coerce).filter((f): f is ParsedReviewFinding => f !== null);
}

/** The instruction appended to the review prompt so output is parseable + rich. */
export const REVIEW_OUTPUT_CONTRACT =
  'You are in READ-ONLY review mode: do NOT edit files, run shell commands, or call any tools — analyze the diff shown above.\n' +
  'FIRST, write a short UNDERSTANDING section in plain markdown (NO code fences anywhere in it) so a human can build the mental model:\n' +
  '  "## What changed" — 2-4 sentences: what this change does, why, and what it touches (use the Change impact above).\n' +
  '  "## Check your understanding" — exactly 3 short questions that verify a reader actually grasped the change; put each answer inside a `<details><summary>Answer</summary> … </details>` so it stays hidden until revealed.\n' +
  'THEN end your reply with a fenced ```json array of findings. Each finding object: {' +
  '"file": "<repo-relative path>", "line": <first affected line|null>, "endLine": <last affected line|null>, ' +
  '"severity": "critical|high|medium|low|info", "confidence": <0-100>, ' +
  '"summary": "<one line>", "details": "<why this is a real issue>", "suggestion": "<the concrete fix>", ' +
  '"codeExcerpt": "<3-8 verbatim lines of the affected code, indentation preserved>", ' +
  '"diffHunk": "<optional unified-diff hunk: problem lines prefixed - , suggested lines prefixed + >", ' +
  '"patch": "<optional FULL git-apply-able unified diff, ONLY when the fix is small and safe to auto-apply>"}. ' +
  'Quote code verbatim (preserve indentation) in codeExcerpt/diffHunk/patch. Only flag real issues introduced by the diff — an empty array [] is correct when the changes look good.';

/** Strip a model's reasoning block(s) — <think>/<thinking>/<thought>/<reasoning>,
 *  closed or an unclosed leading one — so chain-of-thought never leaks into the
 *  review summary shown in the panel. Pure + unit-tested. */
export function stripReasoning(text: string): string {
  const THINK = '(?:think|thinking|thought|reasoning)';
  return (text ?? '')
    .replace(new RegExp(`<(${THINK})>[\\s\\S]*?<\\/\\1>`, 'gi'), '')
    .replace(new RegExp(`<${THINK}>[\\s\\S]*$`, 'i'), '')
    .replace(new RegExp(`<\\/?${THINK}>`, 'gi'), '')
    .trim();
}
