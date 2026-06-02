/**
 * MAS-P3-P3.2 (0.4.1) — parent synthesis roll-up.
 *
 * Takes a batch of finished child sessions and produces a clean roll-up
 * grouped by role (output-contract id), pulling the parsed contract
 * fields when the child honoured its contract and falling back to a
 * preview otherwise. The parent uses this to compose a final answer
 * from a fan-out instead of pasting N raw child transcripts.
 *
 * Pure (no I/O) so it unit-tests without the orchestration runtime.
 */

import { parseChildOutput } from "./outputContracts.js";
import { mergeAndFilterFindings, renderReviewReport, type ReviewFinding, type ReviewSynthesis } from "./reviewSynthesis.js";

export interface SynthChild {
  id: string;
  role: string;
  status: string;
  finalOutput?: string;
  error?: string;
}

export interface SynthEntry {
  id: string;
  role: string;
  status: string;
  contractStatus: "parsed" | "unparsed" | "none";
  fields: Record<string, string>;
  missing: string[];
  /** Short preview when the contract didn't parse (or the role has none). */
  preview?: string;
  error?: string;
}

export interface SynthesisRollup {
  total: number;
  completed: number;
  failed: number;
  /** Entries grouped by role, role keys sorted. */
  byRole: Record<string, SynthEntry[]>;
}

function previewOf(text: string | undefined, max = 280): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function synthesizeChildren(children: SynthChild[]): SynthesisRollup {
  const byRole: Record<string, SynthEntry[]> = {};
  let completed = 0;
  let failed = 0;

  for (const c of children) {
    if (c.status === "completed") completed++;
    else if (c.status === "failed") failed++;

    const parsed = c.finalOutput ? parseChildOutput(c.role, c.finalOutput) : null;
    const entry: SynthEntry = {
      id: c.id,
      role: c.role,
      status: c.status,
      contractStatus: parsed ? parsed.contractStatus : "none",
      fields: parsed?.fields ?? {},
      missing: parsed?.missing ?? [],
      preview: parsed?.contractStatus === "parsed" ? undefined : previewOf(c.finalOutput),
      error: c.error,
    };
    (byRole[c.role] ??= []).push(entry);
  }

  // Sort role keys for stable rendering.
  const sorted: Record<string, SynthEntry[]> = {};
  for (const role of Object.keys(byRole).sort()) sorted[role] = byRole[role];

  return { total: children.length, completed, failed, byRole: sorted };
}

/** Render a synthesis roll-up as compact markdown for the parent / `/agents`. */
export function renderSynthesis(rollup: SynthesisRollup): string {
  const lines: string[] = [
    `## Fan-out synthesis (${rollup.completed}/${rollup.total} completed${rollup.failed ? `, ${rollup.failed} failed` : ""})`,
  ];
  for (const [role, entries] of Object.entries(rollup.byRole)) {
    lines.push(`\n### ${role}`);
    for (const e of entries) {
      lines.push(`- **${e.id}** — ${e.status}${e.error ? ` (error: ${e.error})` : ""}`);
      if (e.contractStatus === "parsed") {
        for (const [field, value] of Object.entries(e.fields)) {
          lines.push(`  - _${field}_: ${value.replace(/\n+/g, " ").slice(0, 200)}`);
        }
      } else if (e.missing.length > 0) {
        lines.push(`  - _(contract unparsed — missing: ${e.missing.join(", ")})_`);
        if (e.preview) lines.push(`  - ${e.preview.replace(/\n+/g, " ")}`);
      } else if (e.preview) {
        lines.push(`  - ${e.preview.replace(/\n+/g, " ")}`);
      }
    }
  }
  return lines.join("\n");
}

// ── WF-SYNTH (0.4.8) — phase-level synthesis + typed hand-off ─────────────────

export type PhaseSynthesisMode = "none" | "role-rollup" | "review-merge";

/** Typed aggregation of a phase's children, plus the rendered text fed forward
 *  as `{{input}}` to downstream phases. */
export interface PhaseOutput {
  mode: PhaseSynthesisMode;
  text: string;
  /** Present for `role-rollup` (and `review-merge` when it fell back). */
  rollup?: SynthesisRollup;
  /** Present for `review-merge` when structured findings were merged. */
  review?: ReviewSynthesis;
}

const FINDING_CONFIDENCE_THRESHOLD = 50;

function coerceFinding(x: Record<string, unknown>, reviewer?: string): ReviewFinding | null {
  const summary =
    typeof x.summary === "string" ? x.summary.trim() : typeof x.message === "string" ? x.message.trim() : "";
  const file = typeof x.file === "string" ? x.file.trim() : "";
  if (!summary || !file) return null; // need file + summary to count as a finding
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const conf = num(x.confidence);
  return {
    file,
    line: num(x.line),
    lineEnd: num(x.lineEnd),
    severity: typeof x.severity === "string" ? x.severity : "info",
    confidence: conf === null ? 50 : Math.max(0, Math.min(100, conf)),
    summary,
    reviewer: typeof x.reviewer === "string" ? x.reviewer : reviewer,
    rootCause: typeof x.rootCause === "string" ? x.rootCause : undefined,
  };
}

/**
 * Tolerant extraction of structured review findings from a child's freeform
 * output. Reviewers are prompted to emit a fenced ```json [ {file,line,severity,
 * confidence,summary}, ... ] ``` block (or a `{"findings":[...]}`); this scans
 * the first fenced block, then a bare array/object, and coerces finding-shaped
 * items. Returns `[]` when nothing parseable is present — so `review-merge`
 * degrades to a role rollup rather than inventing findings.
 */
export function extractReviewFindings(text: string | undefined, reviewer?: string): ReviewFinding[] {
  if (!text) return [];
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) candidates.push(arr[0]);
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) candidates.push(obj[0]);
  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c.trim());
    } catch {
      continue;
    }
    const list: unknown = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).findings)
        ? (parsed as Record<string, unknown>).findings
        : null;
    if (!Array.isArray(list)) continue;
    const findings = list
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
      .map((x) => coerceFinding(x, reviewer))
      .filter((f): f is ReviewFinding => f !== null);
    if (findings.length > 0) return findings;
  }
  return [];
}

/**
 * Aggregate a phase's children into a typed `PhaseOutput`:
 *   - `none`         → raw child outputs concatenated.
 *   - `role-rollup`  → group-by-role contract digest (`synthesizeChildren`).
 *   - `review-merge` → extract + dedupe + threshold findings across reviewers
 *                      (`mergeAndFilterFindings`); falls back to `role-rollup`
 *                      when no structured findings are present.
 */
export function synthesizePhase(children: SynthChild[], mode: PhaseSynthesisMode): PhaseOutput {
  if (mode === "none") {
    const text = children
      .map((c) => c.finalOutput?.trim())
      .filter((t): t is string => Boolean(t))
      .join("\n\n---\n\n");
    return { mode, text };
  }
  if (mode === "review-merge") {
    const findings = children.flatMap((c) => extractReviewFindings(c.finalOutput, c.role));
    if (findings.length > 0) {
      const review = mergeAndFilterFindings(findings, FINDING_CONFIDENCE_THRESHOLD);
      return { mode, text: renderReviewReport(review, FINDING_CONFIDENCE_THRESHOLD), review };
    }
    const rollup = synthesizeChildren(children); // graceful fallback — no findings to merge
    return { mode, text: renderSynthesis(rollup), rollup };
  }
  const rollup = synthesizeChildren(children);
  return { mode, text: renderSynthesis(rollup), rollup };
}
