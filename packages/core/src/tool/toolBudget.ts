/**
 * MAS-P4-T1 (0.4.1) — tool-surface budgeting.
 *
 * A big MCP catalog (dozens of tools across several servers) bloats every
 * turn's prompt and dilutes the model's tool choice. When the visible MCP
 * tool count exceeds a budget, rank tools by relevance to the current task
 * (token overlap with name + description) and keep only the top N. The
 * trimmed tools aren't gone — calling one returns a structured "hidden by
 * budget" error so the model can retry with intent, and the budget is
 * configurable via `cli.agentMcpToolBudget` (default 40).
 *
 * Also supports per-agent-definition scoping: an agent def may whitelist
 * `toolScope.mcp` and blacklist `disallowedTools`.
 *
 * Pure module (no I/O) so it unit-tests cleanly.
 */

export interface BudgetableTool {
  /** Model-facing tool name (may be the `mcp_<server>_<tool>` form). */
  name: string;
  description?: string;
}

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/** Relevance = count of distinct task tokens that appear in the tool's name+description. */
export function toolRelevanceScore(tool: BudgetableTool, taskTokens: Set<string>): number {
  if (taskTokens.size === 0) return 0;
  const hay = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  let score = 0;
  for (const tok of taskTokens) {
    if (hay.includes(tok)) score++;
  }
  return score;
}

/**
 * Apply an agent definition's scope to a tool list: keep only names in
 * `allow.mcp` (when non-empty) and drop any in `disallow`. Matches the bare
 * tool name or any `_<bare>` suffix (pool-normalised `mcp_<server>_<tool>`).
 */
export function applyToolScope<T extends BudgetableTool>(
  tools: T[],
  scope?: { allow?: string[]; disallow?: string[] },
): T[] {
  if (!scope) return tools;
  const allow = (scope.allow ?? []).filter(Boolean);
  const disallow = new Set((scope.disallow ?? []).filter(Boolean));
  const matches = (name: string, list: Iterable<string>): boolean => {
    for (const entry of list) if (name === entry || name.endsWith(`_${entry}`)) return true;
    return false;
  };
  return tools.filter((t) => {
    if (disallow.size && matches(t.name, disallow)) return false;
    if (allow.length && !matches(t.name, allow)) return false;
    return true;
  });
}

export interface BudgetResult<T> {
  kept: T[];
  /** Tools trimmed because the catalog exceeded the budget. */
  hidden: T[];
}

/**
 * Cap `tools` to `budget`, keeping the most task-relevant. Stable: ties and
 * the no-signal case (empty task) preserve original order. `budget <= 0` or a
 * catalog already within budget is returned unchanged (nothing hidden).
 */
export function rankAndCapTools<T extends BudgetableTool>(
  tools: T[],
  taskText: string,
  budget: number,
): BudgetResult<T> {
  if (budget <= 0 || tools.length <= budget) return { kept: tools, hidden: [] };
  const taskTokens = new Set(tokenize(taskText));
  const scored = tools.map((tool, index) => ({ tool, index, score: toolRelevanceScore(tool, taskTokens) }));
  // Highest score first; stable by original index on ties.
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  const keptSet = new Set(scored.slice(0, budget).map((s) => s.index));
  const kept: T[] = [];
  const hidden: T[] = [];
  tools.forEach((tool, i) => (keptSet.has(i) ? kept : hidden).push(tool));
  return { kept, hidden };
}
