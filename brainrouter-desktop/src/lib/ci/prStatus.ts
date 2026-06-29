/**
 * §session-pr — map a session's git branch to its PR status, from the all-states
 * PR rows fetched by the host (`git-pr-status-map`). Pure + unit-tested so the
 * sidebar icon logic stays trivial and predictable.
 */
export type PrStatus = 'open' | 'draft' | 'conflict' | 'merged' | 'closed';

export interface PrStatusRow {
  number?: number;
  state?: string; // OPEN | MERGED | CLOSED (GitHub wire case)
  headRefName?: string;
  isDraft?: boolean;
  mergeable?: string; // MERGEABLE | CONFLICTING | UNKNOWN
  url?: string;
}

/** Index PR rows by head branch. A branch can carry an old closed/merged PR AND
 *  a fresh open one — prefer the OPEN row so the live state wins. */
export function indexPrsByBranch(prs: PrStatusRow[]): Record<string, PrStatusRow> {
  const out: Record<string, PrStatusRow> = {};
  for (const pr of prs) {
    const b = pr?.headRefName;
    if (!b) continue;
    const prev = out[b];
    if (!prev || (prev.state !== 'OPEN' && pr.state === 'OPEN')) out[b] = pr;
  }
  return out;
}

/** Resolve the PR status for `branch` (null when there's no branch or no PR). */
export function prStatusFor(
  branch: string | null | undefined,
  byBranch: Record<string, PrStatusRow>,
): { status: PrStatus; pr: PrStatusRow } | null {
  if (!branch) return null;
  const pr = byBranch[branch];
  if (!pr) return null;
  const state = (pr.state ?? '').toUpperCase();
  if (state === 'MERGED') return { status: 'merged', pr };
  if (state === 'CLOSED') return { status: 'closed', pr };
  // OPEN — draft and conflict are the meaningful sub-states.
  if (pr.isDraft) return { status: 'draft', pr };
  if ((pr.mergeable ?? '').toUpperCase() === 'CONFLICTING') return { status: 'conflict', pr };
  return { status: 'open', pr };
}

/** Short human label for tooltips. */
export function prStatusLabel(status: PrStatus): string {
  switch (status) {
    case 'open': return 'Open';
    case 'draft': return 'Draft';
    case 'conflict': return 'Conflict';
    case 'merged': return 'Merged';
    case 'closed': return 'Closed';
  }
}
