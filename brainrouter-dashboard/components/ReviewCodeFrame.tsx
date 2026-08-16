"use client";

/**
 * ADR-036 — the finding carries its code. Renders a finding's own hunk: the
 * reviewed lines (D2), the proposed before/after when the bot suggests one (D3),
 * as escaped, bounded data (D5). The source is attacker-influenced, so it is
 * rendered as text — React escapes {row.text}, never markup — long lines scroll
 * within the block, and the excerpt is capped with the truncation stated.
 */
import { useMemo } from "react";
import { findingRows, type CodeRow } from "../lib/review/reviewCode";

const MAX_ROWS = 60;

interface CodeFrameFinding {
  file?: string;
  line?: number;
  endLine?: number;
  codeExcerpt?: string;
  replacement?: string;
  diffHunk?: string;
}

const ROW_BG: Record<CodeRow["kind"], string> = {
  add: "rgba(52, 194, 142, 0.14)",
  del: "rgba(229, 103, 95, 0.14)",
  problem: "rgba(229, 103, 95, 0.14)",
  ctx: "transparent",
  meta: "rgba(148, 150, 160, 0.10)",
};
const ROW_MARK: Record<CodeRow["kind"], string> = { add: "+", del: "−", problem: "!", ctx: " ", meta: " " };
const ROW_FG: Record<CodeRow["kind"], string> = {
  add: "var(--success, #34C28E)",
  del: "var(--danger, #E5675F)",
  problem: "var(--danger, #E5675F)",
  ctx: "var(--color-silver-text, inherit)",
  meta: "var(--color-stone-text, #9496A0)",
};

export function ReviewCodeFrame({ finding }: { finding: CodeFrameFinding }) {
  const rows = useMemo(
    () => findingRows({
      codeExcerpt: finding.codeExcerpt,
      diffHunk: finding.diffHunk,
      line: finding.line,
      endLine: finding.endLine,
      suggestion: finding.replacement,
    }),
    [finding.codeExcerpt, finding.diffHunk, finding.line, finding.endLine, finding.replacement],
  );
  if (rows.length === 0) return null;

  const shown = rows.slice(0, MAX_ROWS);
  const hidden = rows.length - shown.length;
  const hasSuggestion = rows.some((r) => r.kind === "add" || r.kind === "del");

  return (
    <div className="review-codeframe" style={{
      marginTop: "var(--spacing-8, 8px)", border: "1px solid var(--border-med, rgba(148,150,160,0.25))",
      borderRadius: "8px", overflow: "hidden", background: "var(--color-pewter-accent, rgba(148,150,160,0.05))",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", fontSize: "11px",
        color: "var(--color-stone-text, #9496A0)", borderBottom: "1px solid var(--border-med, rgba(148,150,160,0.2))",
      }}>
        <code style={{ fontSize: "11px" }}>{finding.file ?? "source"}{finding.line ? `:${finding.line}` : ""}</code>
        {hasSuggestion && <span style={{ marginLeft: "auto", fontStyle: "italic" }}>Suggested fix — a proposal, not an applied patch</span>}
      </div>
      <div style={{ overflowX: "auto", fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)", fontSize: "12px", lineHeight: 1.55 }}>
        {shown.map((row, i) => (
          <div key={i} style={{ display: "flex", background: ROW_BG[row.kind], whiteSpace: "pre" }}>
            <span aria-hidden style={{ flex: "0 0 3.2em", textAlign: "right", padding: "0 8px", userSelect: "none", color: "var(--color-stone-text, #9496A0)", opacity: 0.7 }}>
              {row.lineNo ?? ""}
            </span>
            <span aria-hidden style={{ flex: "0 0 1.2em", textAlign: "center", userSelect: "none", color: ROW_FG[row.kind] }}>
              {ROW_MARK[row.kind]}
            </span>
            <span style={{ flex: 1, padding: "0 8px 0 4px", color: row.kind === "ctx" ? "inherit" : ROW_FG[row.kind] }}>
              {row.text === "" ? " " : row.text}
            </span>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <div style={{ padding: "5px 10px", fontSize: "11px", color: "var(--color-stone-text, #9496A0)", borderTop: "1px solid var(--border-med, rgba(148,150,160,0.2))" }}>
          … {hidden} more line{hidden === 1 ? "" : "s"} not shown (excerpt truncated)
        </div>
      )}
    </div>
  );
}
