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
