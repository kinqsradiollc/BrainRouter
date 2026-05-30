/**
 * CLI-14 (0.4.3) — `/context offloads` browser.
 *
 * Lists the working-memory offloads (payloads pushed out of context to a
 * durable ref) with their originating tool, token savings, durable ref id, and
 * timestamp — so a user can see what was offloaded and expand it
 * (`memory_working_context` with the nodeId). Pure (no chalk) for testability;
 * the command handler colours rows.
 */

export interface OffloadStep {
  nodeId: string;
  title?: string;
  summary?: string;
  /** Originating tool / source kind. */
  kind?: string;
  /** Durable ref path. */
  refPath?: string;
  /** ~tokens kept out of context by offloading. */
  tokenEstimate?: number;
  createdAt?: string;
}

function snippet(text: string | undefined, max = 90): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function formatOffloadList(steps: OffloadStep[]): string[] {
  if (!steps.length) return ["No offloads in this session's working memory."];

  // Biggest token savings first — that's what a user scanning for bloat wants.
  const sorted = [...steps].sort((a, b) => (b.tokenEstimate ?? 0) - (a.tokenEstimate ?? 0));
  const totalSaved = sorted.reduce((sum, s) => sum + (s.tokenEstimate ?? 0), 0);

  const lines: string[] = [`${sorted.length} offload${sorted.length === 1 ? "" : "s"} · ~${totalSaved.toLocaleString()} tokens kept out of context`, ""];
  for (const s of sorted) {
    const kind = s.kind ?? "tool_output";
    const saved = s.tokenEstimate != null ? `~${s.tokenEstimate.toLocaleString()} tok` : "size unknown";
    const when = s.createdAt ? ` · ${s.createdAt.slice(0, 19).replace("T", " ")}` : "";
    lines.push(`[${kind}] ${s.title ?? s.nodeId} — ${saved} · ref ${s.nodeId}${when}`);
    const sum = snippet(s.summary);
    if (sum) lines.push(`  ${sum}`);
  }
  lines.push("");
  lines.push("Expand one with: memory_working_context (nodeId: <ref>)");
  return lines;
}
