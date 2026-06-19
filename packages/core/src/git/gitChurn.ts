/**
 * B7 (MEM-CHURN, 0.4.11) — recent-churn signal for a file: the number of commits
 * touching it in the last 90 days + its most-recent commit date. Captured at
 * index time and stored on the source document so recall can decay memories
 * anchored to volatile files faster.
 *
 * Best-effort: returns nulls when the workspace isn't a git repo, the file isn't
 * tracked, or git is unavailable. Only ever called on the reindex path (which is
 * already gated on content drift), so the `git log` subprocess runs on real edits
 * — not on every file read.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export interface ChurnSignal {
  commitCount90d: number | null;
  lastCommitDate: string | null;
}

const NONE: ChurnSignal = { commitCount90d: null, lastCommitDate: null };

export function gitChurnSignal(repoRoot: string, filePath: string): ChurnSignal {
  try {
    const rel = path.relative(repoRoot, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return NONE; // outside the repo
    const res = spawnSync(
      'git',
      ['-C', repoRoot, 'log', '--since=90.days.ago', '--pretty=format:%cI', '--', rel],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (res.status !== 0 || typeof res.stdout !== 'string') return NONE;
    const dates = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    // `--pretty=%cI` newest-first → one line per commit; first line = most recent.
    return { commitCount90d: dates.length, lastCommitDate: dates[0] ?? null };
  } catch {
    return NONE;
  }
}
