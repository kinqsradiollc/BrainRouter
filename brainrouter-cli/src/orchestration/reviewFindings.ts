/**
 * T12 — parse a single review agent turn's output into structured findings.
 * The desktop "review working changes" turn is asked to end with a fenced
 * ```json array of findings; this extracts and validates it, tolerating prose
 * around the block and a missing/!malformed block (→ []). Reuses the
 * ReviewFinding shape so it composes with the existing review synthesis.
 */
import type { ReviewFinding } from './reviewSynthesis.js';

const SEVERITIES = new Set(['bug', 'security', 'perf', 'style', 'nit', 'info', 'warn']);

/** Extract the LAST fenced ```json block from a markdown string, or null. */
export function lastJsonBlock(text: string): string | null {
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1].trim();
  return last;
}

/** Coerce one raw object into a ReviewFinding (dropping anything unusable). */
function coerce(raw: unknown): ReviewFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const file = typeof o.file === 'string' ? o.file.trim() : '';
  const summary = typeof o.summary === 'string' ? o.summary.trim() : (typeof o.message === 'string' ? o.message.trim() : '');
  if (!file || !summary) return null;
  const sevRaw = typeof o.severity === 'string' ? o.severity.toLowerCase().trim() : 'info';
  const severity = SEVERITIES.has(sevRaw) ? sevRaw : 'info';
  const confidence = typeof o.confidence === 'number' ? Math.max(0, Math.min(100, o.confidence)) : 70;
  const line = typeof o.line === 'number' ? o.line : (typeof o.line === 'string' && /^\d+$/.test(o.line) ? Number(o.line) : undefined);
  return { file, line, severity, confidence, summary, reviewer: 'review' };
}

export function parseReviewFindings(text: string): ReviewFinding[] {
  const block = lastJsonBlock(text);
  if (!block) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(block); } catch { return []; }
  const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings) ? (parsed as { findings: unknown[] }).findings : []);
  return arr.map(coerce).filter((f): f is ReviewFinding => f !== null);
}

/** The instruction appended to the review prompt so output is parseable. */
export const REVIEW_OUTPUT_CONTRACT =
  'End your reply with a fenced ```json array of findings, each: ' +
  '{"file": "path", "line": <number|null>, "severity": "bug|security|perf|style|nit|info", "confidence": <0-100>, "summary": "one line"}. ' +
  'Only include real issues in the diff; an empty array [] is correct when the changes look good.';
