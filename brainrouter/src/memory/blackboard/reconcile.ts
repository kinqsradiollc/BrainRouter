import type { BlackboardItem } from "@kinqs/brainrouter-types";

/**
 * 0.4.3 (MEM-4) — pure blackboard reconciler.
 *
 * Given staged candidates, decide which survive to commit: dedup by normalized
 * content (highest score wins; the rest become `duplicate` pointing at the
 * winner) and reject anything below a score threshold. Deterministic — no LLM —
 * so it unit-tests cleanly and the same input always reconciles the same way.
 */

function norm(s: string): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export interface ReconcileDecision {
  id: string;
  status: "reconciled" | "duplicate" | "rejected";
  score: number;
  /** For a winner: the duplicate ids it absorbed. For a duplicate: [winnerId]. */
  conflictIds: string[];
}

export interface ReconcileOptions {
  /** Candidates scoring below this are rejected. Default 0.3. */
  minScore?: number;
}

export function reconcileBlackboard(items: BlackboardItem[], opts: ReconcileOptions = {}): ReconcileDecision[] {
  const minScore = opts.minScore ?? 0.3;

  const groups = new Map<string, BlackboardItem[]>();
  for (const it of items) {
    const key = norm(it.candidate.content);
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }

  const decisions: ReconcileDecision[] = [];
  for (const group of groups.values()) {
    // Winner = highest score; deterministic tie-break by createdAt then id.
    const sorted = [...group].sort(
      (a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const winner = sorted[0];
    const dupIds = sorted.slice(1).map((i) => i.id);
    for (const it of sorted) {
      if (it.id === winner.id) {
        decisions.push({
          id: it.id,
          status: it.score < minScore ? "rejected" : "reconciled",
          score: it.score,
          conflictIds: dupIds,
        });
      } else {
        decisions.push({ id: it.id, status: "duplicate", score: it.score, conflictIds: [winner.id] });
      }
    }
  }
  return decisions;
}
