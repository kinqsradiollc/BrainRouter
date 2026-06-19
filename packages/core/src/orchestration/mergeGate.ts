/**
 * BUILD-LOOP P2.5 (0.4.12) — cross-worktree synthesis: the structural half of the
 * pre-merge gate for a FAN-OUT build (multiple slice workers → multiple worktrees).
 *
 * Pure — no I/O. Given each slice's change-set (the files its worktree touched, from
 * its recovery patch), decide which worktrees are safe to merge and which must be
 * HELD: two slices editing the SAME file overlap and can't both land cleanly, and a
 * synthesis reviewer's `blocker` verdict holds everything. The actual apply
 * (check-then-apply of the held patches onto the parent tree) lives in
 * `finalizeFanOutBuild`; this module just plans the merge + names the conflicts.
 */

export interface WorktreeChangeSet {
  /** Child/agent id whose worktree produced these changes. */
  id: string;
  /** Repo-relative file paths the slice touched (parsed from its recovery patch). */
  files: string[];
  /** Optional human label (the slice description). */
  label?: string;
}

export interface SynthesisMergePlan {
  /** Worktrees cleared to merge, in apply order. */
  merge: string[];
  /** Worktrees held back, each with a human-readable reason. */
  hold: Array<{ id: string; reason: string }>;
  /** Files touched by >1 worktree (the structural conflicts surfaced to the user). */
  overlaps: Array<{ file: string; ids: string[] }>;
}

/** Extract the repo-relative files a unified-diff patch touches. Pure.
 *  Reads the `diff --git a/<old> b/<new>` headers, preferring the new (`b/`) path. */
export function parsePatchFiles(patchText: string): string[] {
  const files = new Set<string>();
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patchText)) !== null) {
    const f = (m[2] || m[1] || '').trim();
    if (f && f !== '/dev/null') files.add(f);
  }
  return [...files];
}

/** Files touched by more than one worktree. Pure. */
export function findCrossWorktreeOverlaps(changeSets: WorktreeChangeSet[]): Array<{ file: string; ids: string[] }> {
  const byFile = new Map<string, string[]>();
  for (const cs of changeSets) {
    for (const f of new Set(cs.files)) {
      const ids = byFile.get(f) ?? [];
      ids.push(cs.id);
      byFile.set(f, ids);
    }
  }
  const overlaps: Array<{ file: string; ids: string[] }> = [];
  for (const [file, ids] of byFile) if (ids.length > 1) overlaps.push({ file, ids });
  return overlaps;
}

/**
 * Plan the gated merge of a fan-out build's slice worktrees.
 *
 *  - A synthesis reviewer `blocker` (the cross-worktree review verdict) HOLDS every
 *    slice — nothing lands until the human resolves it.
 *  - Otherwise slices merge in input order; a slice is held when it would touch a
 *    file an already-merged slice claimed (the overlap that a per-worktree review
 *    structurally can't catch). First writer wins; later overlappers are preserved
 *    as recovery patches with the conflict named — never clobbered.
 *
 * Pure: the caller does the actual check-then-apply of `merge` in order.
 */
export function planSynthesisMerge(
  changeSets: WorktreeChangeSet[],
  opts: { synthesisBlocker?: boolean } = {},
): SynthesisMergePlan {
  const overlaps = findCrossWorktreeOverlaps(changeSets);
  if (opts.synthesisBlocker) {
    return {
      merge: [],
      hold: changeSets.map((cs) => ({ id: cs.id, reason: 'synthesis review flagged a blocker — all slices held for manual resolution' })),
      overlaps,
    };
  }
  const claimed = new Map<string, string>(); // file -> first merging slice id
  const merge: string[] = [];
  const hold: Array<{ id: string; reason: string }> = [];
  for (const cs of changeSets) {
    const files = [...new Set(cs.files)];
    const conflicts = files.filter((f) => claimed.has(f));
    if (conflicts.length === 0) {
      merge.push(cs.id);
      for (const f of files) claimed.set(f, cs.id);
    } else {
      const detail = conflicts.map((f) => `${f} (also in ${claimed.get(f)})`).join(', ');
      hold.push({ id: cs.id, reason: `overlaps an earlier slice on ${detail} — held to avoid clobbering` });
    }
  }
  return { merge, hold, overlaps };
}
