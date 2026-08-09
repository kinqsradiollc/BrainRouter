/**
 * T12 / Review v2 — parse a single review agent turn's output into structured
 * findings rich enough to render a real PR-style review: not just a summary, but
 * the affected file + line range, why it's a real issue, the suggested fix, a
 * verbatim code excerpt / mini diff hunk, and (when safe) a git-apply-able patch.
 * The reviewer is asked to end with a fenced ```json array (REVIEW_OUTPUT_CONTRACT);
 * this extracts + validates it, tolerating prose around it and a missing/malformed
 * block (→ []). Pure + unit-tested; the host maps these onto the stored ReviewFinding.
 */
import { UNVERIFIED_CLAIM } from './reviewGrounding.js';

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
  /**
   * The EXACT replacement code for lines [line..endLine], with NO diff prefixes —
   * dropped verbatim into a GitHub ```suggestion block so the author can click
   * "Apply suggestion". Distinct from `suggestion` (prose rationale). Only set when
   * the fix is a safe, self-contained line replacement.
   */
  replacement?: string;
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
const PUBLICATION_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const PUBLICATION_FINDING_FIELDS = new Set([
  'file',
  'line',
  'endLine',
  'severity',
  'preExisting',
  'confidence',
  'summary',
  'details',
  'suggestion',
  'replacement',
  'codeExcerpt',
  'diffHunk',
  'patch',
]);

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
    replacement: str(o.replacement) ?? str(o.suggestedCode) ?? str(o.fix),
    codeExcerpt: str(o.codeExcerpt) ?? str(o.excerpt),
    diffHunk: str(o.diffHunk) ?? str(o.hunk),
    patch: str(o.patch),
    // Accept `preExisting` / `preexisting` (bool) or a "pre-existing" severity label.
    preExisting: o.preExisting === true || o.preexisting === true || sevRaw === 'pre-existing' || sevRaw === 'preexisting' || undefined,
  };
}

/**
 * Validate the model-facing publication schema without legacy coercions.
 *
 * The permissive reader above is retained for historical stored reviews. New
 * PR/local/benchmark output must not silently turn a missing or misspelled
 * blocking severity into `info`, manufacture a confidence score, or accept a
 * line encoded with the wrong JSON type.
 */
function validatePublicationFinding(raw: unknown): ParsedReviewFinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const finding = raw as Record<string, unknown>;
  if (Object.keys(finding).some((field) => !PUBLICATION_FINDING_FIELDS.has(field))) return null;

  const file = str(finding.file)?.trim();
  const summary = str(finding.summary)?.trim();
  const severity = typeof finding.severity === 'string'
    ? finding.severity.trim().toLowerCase()
    : '';
  const confidence = finding.confidence;
  if (
    !file
    || !summary
    || !PUBLICATION_SEVERITIES.has(severity)
    || typeof confidence !== 'number'
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 100
  ) return null;

  const invalidLine = Symbol('invalid-review-line');
  const optionalLine = (value: unknown): number | undefined | typeof invalidLine => {
    if (value === undefined || value === null) return undefined;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : invalidLine;
  };
  const line = optionalLine(finding.line);
  const endLine = optionalLine(finding.endLine);
  if (line === invalidLine || endLine === invalidLine) return null;
  if (line !== undefined && endLine !== undefined && endLine < line) return null;

  const optionalString = (field: string): string | undefined | null => {
    const value = finding[field];
    if (value === undefined) return undefined;
    return typeof value === 'string' && value.trim() ? value : null;
  };
  const details = optionalString('details');
  const suggestion = optionalString('suggestion');
  const replacement = optionalString('replacement');
  const codeExcerpt = optionalString('codeExcerpt');
  const diffHunk = optionalString('diffHunk');
  const patch = optionalString('patch');
  if ([details, suggestion, replacement, codeExcerpt, diffHunk, patch].includes(null)) return null;
  if (finding.preExisting !== undefined && typeof finding.preExisting !== 'boolean') return null;

  return {
    file,
    ...(line !== undefined ? { line } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    severity,
    confidence,
    summary,
    ...(details ? { details } : {}),
    ...(suggestion ? { suggestion } : {}),
    ...(replacement ? { replacement } : {}),
    ...(codeExcerpt ? { codeExcerpt } : {}),
    ...(diffHunk ? { diffHunk } : {}),
    ...(patch ? { patch } : {}),
    ...(finding.preExisting === true ? { preExisting: true } : {}),
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

export type ReviewFindingsEnvelopeResult =
  | { ok: true; findings: ParsedReviewFinding[] }
  | { ok: false; error: string };

/**
 * Parse the required findings envelope without letting dropped entries become
 * a false clean review. This is the publication parser used by every current
 * review front door; the permissive parser above remains for legacy readers.
 */
export function parseReviewFindingsEnvelope(text: string): ReviewFindingsEnvelopeResult {
  const raw = String(text ?? '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = fence.exec(raw)) !== null) last = match;
  if (!last) return { ok: false, error: 'reviewer returned no fenced JSON findings envelope' };
  if (raw.slice(last.index + last[0].length).trim()) {
    return { ok: false, error: 'reviewer did not end with the fenced JSON findings envelope' };
  }
  const block = last[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return { ok: false, error: 'reviewer returned malformed JSON findings' };
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  const entries = Array.isArray(parsed)
    ? parsed
    : record && Object.keys(record).length === 1 && Array.isArray(record.findings)
      ? record.findings
      : null;
  if (!entries) return { ok: false, error: 'reviewer JSON did not contain only a findings array' };
  const findings = entries.map(validatePublicationFinding);
  if (findings.some((entry) => entry === null)) {
    return { ok: false, error: 'reviewer returned one or more invalid findings' };
  }
  return { ok: true, findings: findings as ParsedReviewFinding[] };
}

/**
 * Merge findings gathered across review units, dropping duplicates. Two
 * findings are "the same" when they name the same file, line, and summary — so
 * a finding on a file that straddled a bundle boundary is reported once.
 *
 * ADR-033 D2 moved this next to the parser it feeds: with bundles running
 * concurrently, every surface that collects findings from more than one unit
 * needs it, and two copies of "the same finding" would drift apart.
 */
export function dedupeReviewFindings(findings: readonly ParsedReviewFinding[]): ParsedReviewFinding[] {
  const seen = new Set<string>();
  const out: ParsedReviewFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.file}\n${finding.line ?? ''}\n${finding.summary.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

/**
 * Parse a unified diff into the set of NEW-file line numbers that are commentable
 * on the RIGHT side (the added `+` lines), keyed by repo-relative path. GitHub's
 * Reviews API only accepts an inline comment whose `line` is part of the diff for
 * that file + commit; anchoring to an added line is always valid. Used to keep a
 * finding's inline comment (and its ```suggestion) from 422-ing the whole review.
 */
export function addedLinesByPath(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let path: string | null = null;
  let newLine = 0;
  let inHunk = false;
  for (const raw of (diff ?? '').split('\n')) {
    if (raw.startsWith('diff --git')) { path = null; inHunk = false; continue; }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '').trim();
      path = p === '/dev/null' ? null : p; // added-file target; deletions have no RIGHT side
      inHunk = false;
      continue;
    }
    if (raw.startsWith('--- ')) { inHunk = false; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { newLine = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk || !path) continue;
    if (raw.startsWith('+')) {
      let set = out.get(path);
      if (!set) { set = new Set<number>(); out.set(path, set); }
      set.add(newLine);
      newLine++;
    } else if (raw.startsWith('-')) {
      // removed line — old side only; the new-file counter does not advance
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — not a real line
    } else {
      newLine++; // context line advances the new-file counter
    }
  }
  return out;
}

/** A resolved GitHub inline-comment anchor within the diff. */
export interface InlineAnchor {
  path: string;
  line: number;
  startLine?: number;
  side: 'RIGHT';
  /** Whether it is safe to attach a ```suggestion (the exact [start..line] range is in the diff). */
  suggestable: boolean;
}

/**
 * Resolve a finding to a valid GitHub inline-comment anchor, or null when it can't
 * anchor inside the diff (→ the caller keeps it in the summary comment only). A
 * ```suggestion is only `suggestable` when BOTH the finding's line and endLine are
 * added lines in the diff — otherwise the suggestion range would be wrong and we
 * degrade to a plain inline comment.
 */
export function resolveInlineAnchor(f: ParsedReviewFinding, added: Map<string, Set<number>>): InlineAnchor | null {
  const set = added.get(f.file);
  if (!set || set.size === 0) return null;
  const start = f.line;
  const end = f.endLine && start && f.endLine >= start ? f.endLine : start;
  if (start && end && set.has(start) && set.has(end)) {
    return { path: f.file, line: end, startLine: end > start ? start : undefined, side: 'RIGHT', suggestable: !!f.replacement };
  }
  if (start && set.has(start)) return { path: f.file, line: start, side: 'RIGHT', suggestable: false };
  return null;
}

/** The instruction appended to the review prompt so output is parseable + rich. */
export const REVIEW_OUTPUT_CONTRACT =
  'You are in READ-ONLY review mode. You MUST NOT edit files, write, apply patches, or run shell / mutating commands.\n' +
  'But you are NOT limited to the diff — VERIFY every finding against the real codebase with your read-only tools. Do not guess from the diff alone; a review that only reads the diff misses the bugs that live in the callers.\n' +
  'Tools you SHOULD call while reviewing (all read-only, safe to use freely):\n' +
  '  - `read_file` — open each changed file AND its neighbors/callers for the surrounding context the diff hunk omits.\n' +
  '  - `grep_search` / `glob_files` / `list_dir` — find the callers, the definition, the tests, and other uses of anything the diff changes (a renamed/edited export, a changed signature, a new invariant).\n' +
  'If a "Change impact" block appears above, it is a deterministic blast-radius hint — use it to decide WHICH callers to open with `read_file`.\n' +
  'VERIFICATION BAR: every behavior claim ("this races", "returns undefined", "breaks callers") must be backed by a concrete `file:line` you ACTUALLY READ, not inferred from a name. ' + UNVERIFIED_CLAIM + '\n' +
  '\n' +
  'FIRST, write a short UNDERSTANDING section in plain markdown (NO code fences anywhere in it) so a human can build the mental model:\n' +
  '  "## What changed" — 2-4 sentences: what this change does, why, and what it touches (use any Change impact block plus what you read).\n' +
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
