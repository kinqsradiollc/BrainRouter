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
  // OFFLOAD-GRAPH (0.4.5) — task-graph metadata. Optional + forward-compatible:
  // the brain populates these when it tracks task context; the graph view uses
  // them when present and falls back to grouping by `kind` otherwise.
  /** The task this payload was offloaded under. */
  taskId?: string;
  /** True when the payload can be regenerated/replaced (safe to evict). */
  replaceable?: boolean;
  /** True when this offload belongs to the task currently in focus. */
  currentTask?: boolean;
}

/** Escape a Mermaid node label (quotes + brackets break the parser). */
function mermaidLabel(text: string): string {
  return text.replace(/["[\]{}|]/g, "").replace(/\s+/g, " ").trim();
}

function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 24);
}

/**
 * OFFLOAD-GRAPH — render the offloads as a Mermaid task-graph: a root session
 * node fans out to task groups (by `taskId`, falling back to `kind`), each
 * holding its offload nodes labelled with token savings. The current task and
 * replaceable payloads are marked. Pure (returns lines); the caller prints.
 */
export function formatOffloadGraph(steps: OffloadStep[]): string[] {
  if (!steps.length) return ["No offloads in this session's working memory."];

  // Group by taskId when any step carries one, else by kind.
  const useTask = steps.some((s) => s.taskId);
  const groups = new Map<string, OffloadStep[]>();
  for (const s of steps) {
    const key = (useTask ? s.taskId : s.kind) || "untasked";
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }

  const lines: string[] = ["```mermaid", "graph TD", "  session([session working memory])"];
  let gi = 0;
  for (const [key, group] of groups) {
    const gid = `g${gi++}_${shortId(key)}`;
    const current = group.some((s) => s.currentTask);
    const groupSaved = group.reduce((n, s) => n + (s.tokenEstimate ?? 0), 0);
    lines.push(`  session --> ${gid}["${mermaidLabel(key)}${current ? " *current" : ""} (~${groupSaved} tok)"]`);
    for (const s of group) {
      const nid = `n_${shortId(s.nodeId)}`;
      const saved = s.tokenEstimate != null ? `~${s.tokenEstimate} tok` : "size?";
      const repl = s.replaceable ? " (replaceable)" : "";
      lines.push(`  ${gid} --> ${nid}["${mermaidLabel(s.title ?? s.nodeId)}${repl} (${saved})"]`);
    }
  }
  lines.push("```");
  return lines;
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
