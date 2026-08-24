// ADR-041 A41-13 — a read-only turn/session usage snapshot for a turn-end observer.
//
// The W1 token meter reads per-agent turn-loop state (session usage, task caps,
// per-skill / per-MCP-server accounting) that the extension host does not otherwise
// expose. Rather than widen the host with a live handle onto the Agent, the turn-end
// phase-hook context (registry.ts) carries this bounded, already-computed VIEW: a
// plain snapshot an extension can read without reaching into agent internals. The
// Agent satisfies `TurnUsageReadPort` structurally, so the turn-end site builds the
// view straight from `agent` — and only when a turn-end hook is actually registered.

/** The subset of agent turn-loop state a usage view is built from. */
export interface TurnUsageReadPort {
  llmConfig: { model: string };
  sessionUsage: {
    promptTokens: number; completionTokens: number; calls: number;
    turns: number; cachedTokens: number; missedTokens: number;
  };
  lastTurnUsage: {
    promptTokens: number; completionTokens: number; calls: number;
    cachedTokens: number; missedTokens: number;
  };
  taskBudgetCaps?: { maxPerTaskUSD: number; maxPerTaskTokens: number };
  usageBySkill: Map<string, { promptTokens: number; completionTokens: number; turns: number; calls: number }>;
  mcpServerCallCounts: Map<string, number>;
}

/** A bounded, serializable snapshot of usage as of turn end. */
export interface TurnUsageView {
  model: string;
  /** Cumulative session usage — the measure a task budget is spent against. */
  session: TurnUsageReadPort['sessionUsage'];
  /** The most recent turn's usage. */
  lastTurn: TurnUsageReadPort['lastTurnUsage'];
  /** The active per-task budget caps, when the run has any. */
  taskBudgetCaps?: { maxPerTaskUSD: number; maxPerTaskTokens: number };
  /** Per-skill token accounting, sorted by skill name. */
  bySkill: Array<{ skill: string; promptTokens: number; completionTokens: number; turns: number; calls: number }>;
  /** Per-MCP-server tool-call counts, sorted by server id. */
  byMcpServer: Array<{ server: string; calls: number }>;
}

/** Build the read-only usage view from an agent-shaped read port. */
export function buildTurnUsageView(port: TurnUsageReadPort): TurnUsageView {
  return {
    model: port.llmConfig.model,
    session: { ...port.sessionUsage },
    lastTurn: { ...port.lastTurnUsage },
    ...(port.taskBudgetCaps ? { taskBudgetCaps: { ...port.taskBudgetCaps } } : {}),
    bySkill: [...port.usageBySkill.entries()]
      .map(([skill, u]) => ({ skill, ...u }))
      .sort((a, b) => a.skill.localeCompare(b.skill)),
    byMcpServer: [...port.mcpServerCallCounts.entries()]
      .map(([server, calls]) => ({ server, calls }))
      .sort((a, b) => a.server.localeCompare(b.server)),
  };
}
