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
  /**
   * Claude-style "Pre-existing" (🟣): a real bug the reviewer found in the code
   * this diff *touches* but that this diff did NOT introduce. Reported for
   * awareness; never blocks the gate (see reviewGate → only open/stale + severity).
   */
  preExisting?: boolean;
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
    // Accept `preExisting` / `preexisting` (bool) or a "pre-existing" severity label.
    preExisting: o.preExisting === true || o.preexisting === true || sevRaw === 'pre-existing' || sevRaw === 'preexisting' || undefined,
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
  'You are in READ-ONLY review mode. You MUST NOT edit files, write, apply patches, or run shell / mutating commands.\n' +
  'But you are NOT limited to the diff — VERIFY every finding against the real codebase with your read-only tools. Do not guess from the diff alone; a review that only reads the diff misses the bugs that live in the callers.\n' +
  'Tools you SHOULD call while reviewing (all read-only, safe to use freely):\n' +
  '  - `read_file` — open each changed file AND its neighbors/callers for the surrounding context the diff hunk omits.\n' +
  '  - `grep_search` / `glob_files` / `list_dir` — find the callers, the definition, the tests, and other uses of anything the diff changes (a renamed/edited export, a changed signature, a new invariant).\n' +
  '  - `memory_search` — prior reviews on these files; never re-flag something a past review already accepted. `memory_file_history` — known regressions / past fixes on each changed file.\n' +
  'The Atlas "Change impact" block above already gives you the free, deterministic blast radius — use it to decide WHICH callers to open with `read_file`.\n' +
  'VERIFICATION BAR: every behavior claim ("this races", "returns undefined", "breaks callers") must be backed by a concrete `file:line` you ACTUALLY READ, not inferred from a name. If you could not verify it, do not flag it — false positives waste the author\'s time.\n' +
  '\n' +
  'FIRST, write a short UNDERSTANDING section in plain markdown (NO code fences anywhere in it) so a human can build the mental model:\n' +
  '  "## What changed" — 2-4 sentences: what this change does, why, and what it touches (use the Change impact above + what you read).\n' +
  '  "## Check your understanding" — exactly 3 short questions that verify a reader actually grasped the change; put each answer inside a `<details><summary>Answer</summary> … </details>` so it stays hidden until revealed.\n' +
  '  "## Findings summary" — ONE line tallying the findings by severity, e.g. `2 important · 3 nit · 1 pre-existing`, or `No blocking issues` when nothing important was found.\n' +
  '\n' +
  'SEVERITY (map onto the JSON `severity` field):\n' +
  '  - IMPORTANT → use "critical" or "high": a bug that would break production, corrupt data, or leak secrets — should be fixed before merge.\n' +
  '  - NIT → use "low" or "info": minor issue, worth fixing but not blocking. Report AT MOST 5 nits inline; if there are more, say "plus N more nits" in the summary instead of listing them.\n' +
  '  - PRE-EXISTING → set "preExisting": true: a real bug you verified in the code this diff TOUCHES but that this diff did NOT introduce. Report it for awareness; it never blocks the merge.\n' +
  '\n' +
  'THEN end your reply with a fenced ```json array of findings. Each finding object: {' +
  '"file": "<repo-relative path>", "line": <first affected line|null>, "endLine": <last affected line|null>, ' +
  '"severity": "critical|high|medium|low|info", "preExisting": <true only for a pre-existing bug|false>, "confidence": <0-100>, ' +
  '"summary": "<one line>", "details": "<why this is a real issue + the file:line evidence you verified>", "suggestion": "<the concrete fix>", ' +
  '"codeExcerpt": "<3-8 verbatim lines of the affected code, indentation preserved>", ' +
  '"diffHunk": "<optional unified-diff hunk: problem lines prefixed - , suggested lines prefixed + >", ' +
  '"patch": "<optional FULL git-apply-able unified diff, ONLY when the fix is small and safe to auto-apply>"}. ' +
  'Quote code verbatim (preserve indentation) in codeExcerpt/diffHunk/patch. Flag real, verified issues — an empty array [] is correct when the changes look good.';

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
