/**
 * MAS-P4-T3 (0.4.1) — per-agent accounting helpers.
 *
 * Pure roll-up of child usage so `wait_agents` can return the batch's
 * cost split + offload savings, and `/tokens` can render a "By child"
 * subsection. Kept separate from the orchestration runtime so it's
 * unit-testable without a live agent.
 */

export interface ChildUsageLike {
  promptTokens?: number;
  completionTokens?: number;
  calls?: number;
  offloadedChars?: number;
  wallClockMs?: number;
}

export interface ChildUsageTotals {
  promptTokens: number;
  completionTokens: number;
  calls: number;
  offloadedChars: number;
}

/** Sum the `usage` of a list of summarized children (entries without usage are ignored). */
export function aggregateChildUsage(agents: Array<{ usage?: ChildUsageLike }>): ChildUsageTotals {
  return agents.reduce<ChildUsageTotals>(
    (acc, a) => {
      const u = a?.usage;
      if (u) {
        acc.promptTokens += u.promptTokens ?? 0;
        acc.completionTokens += u.completionTokens ?? 0;
        acc.calls += u.calls ?? 0;
        acc.offloadedChars += u.offloadedChars ?? 0;
      }
      return acc;
    },
    { promptTokens: 0, completionTokens: 0, calls: 0, offloadedChars: 0 },
  );
}
