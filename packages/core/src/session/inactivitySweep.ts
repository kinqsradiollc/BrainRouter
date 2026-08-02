/**
 * ADR-027 D8 (P5-3) — the inactivity sweep, and what deletion cascades to.
 *
 * D8: "A 30-day inactivity sweep archives dormant sessions, and deleting a
 * session or workspace cascades to transcripts, attachments, artifacts, and
 * browser partitions."
 *
 * Two things are deliberately separated here, because conflating them is how
 * cleanup destroys work:
 *
 *   - ARCHIVING is reversible. A dormant session is moved out of the way and
 *     can be brought back whole. This is what the sweep does, on a timer,
 *     without asking.
 *   - DELETION is not. It cascades to every artifact the session owns, and
 *     nothing on a timer should ever do it.
 *
 * The sweep therefore archives and never deletes. A cleanup that silently
 * removes work after thirty days is indistinguishable from data loss to the
 * person who comes back on day thirty-one — and "it was in the settings" is not
 * a defence anyone accepts.
 */

export interface SweepableSession {
  id: string;
  /** ISO timestamp of the last human or agent activity. */
  lastActivityAt: string;
  /** Already archived — the sweep must be idempotent. */
  archived?: boolean;
  /** Pinned sessions are never swept, however dormant. */
  pinned?: boolean;
  /** Unfinished work: a running job, an open plan, an interrupted graph. */
  hasActiveWork?: boolean;
}

export interface SweepOptions {
  /** Point to measure from. Required — never invented here. */
  now: string;
  /** Days of inactivity before archiving. D8 says 30. */
  inactiveDays?: number;
}

export interface SweepPlan {
  /** Session ids to archive, oldest first. */
  archive: readonly string[];
  /** Dormant but protected, with the reason — never silently skipped. */
  retained: readonly { id: string; reason: string }[];
}

export const DEFAULT_INACTIVE_DAYS = 30;

/**
 * Plan an archive sweep.
 *
 * Returns what to archive and — equally important — what was dormant but
 * spared, with the reason. A sweep that reports only its actions makes a
 * protected session look like one it never considered, and the difference
 * matters when someone asks why their session is still there.
 */
export function planInactivitySweep(
  sessions: readonly SweepableSession[],
  options: SweepOptions,
): SweepPlan {
  const days = Math.max(1, Math.floor(options.inactiveDays ?? DEFAULT_INACTIVE_DAYS));
  const cutoff = Date.parse(options.now) - days * 86_400_000;

  const archive: { id: string; at: number }[] = [];
  const retained: { id: string; reason: string }[] = [];

  for (const session of sessions) {
    const activity = Date.parse(session.lastActivityAt);
    // An unparseable timestamp is not evidence of dormancy. Archiving on a
    // date we could not read would sweep sessions for a formatting bug.
    if (!Number.isFinite(activity)) {
      retained.push({ id: session.id, reason: 'Last activity timestamp could not be read.' });
      continue;
    }
    if (activity >= cutoff) continue; // active; not dormant, nothing to report
    if (session.archived) continue;   // already done; the sweep is idempotent

    if (session.pinned) {
      retained.push({ id: session.id, reason: 'Pinned.' });
      continue;
    }
    if (session.hasActiveWork) {
      // Dormant by clock, not by state. Archiving a session with a running job
      // hides work that is still happening.
      retained.push({ id: session.id, reason: 'Has unfinished work.' });
      continue;
    }
    archive.push({ id: session.id, at: activity });
  }

  archive.sort((a, b) => a.at - b.at);
  return { archive: archive.map((entry) => entry.id), retained };
}

/** What deleting a session removes. Ordered so nothing is orphaned midway. */
export const SESSION_CASCADE = [
  'transcript',
  'attachments',
  'artifacts',
  'browser-partition',
] as const;

export type CascadeTarget = (typeof SESSION_CASCADE)[number];

export interface DeletionPlan {
  sessionId: string;
  /** Everything to remove, in order. */
  cascade: readonly CascadeTarget[];
  /**
   * True when this is reversible. Always false — deletion cascades to
   * artifacts, and the flag exists so a caller cannot treat it as an archive
   * by mistake.
   */
  reversible: false;
}

/**
 * Plan a session deletion.
 *
 * Separate from the sweep on purpose, and never called by it. Deletion is
 * always a human decision: the timer archives, a person deletes. That split is
 * the difference between cleanup and data loss.
 */
export function planSessionDeletion(sessionId: string): DeletionPlan {
  return { sessionId, cascade: SESSION_CASCADE, reversible: false };
}

/**
 * Describe a sweep.
 *
 * Returns null when nothing moved — a report that always says something trains
 * people to stop reading it, and the sweep runs unattended and frequently.
 */
export function describeSweep(plan: SweepPlan): string | null {
  if (plan.archive.length === 0 && plan.retained.length === 0) return null;
  const parts: string[] = [];
  if (plan.archive.length > 0) {
    parts.push(`${plan.archive.length} dormant session(s) archived — restore any of them at any time`);
  }
  if (plan.retained.length > 0) {
    const reasons = new Map<string, number>();
    for (const item of plan.retained) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
    const summary = [...reasons.entries()].map(([reason, n]) => `${n} ${reason.toLowerCase().replace(/\.$/, '')}`).join(', ');
    parts.push(`${plan.retained.length} kept (${summary})`);
  }
  return parts.join(' · ');
}
