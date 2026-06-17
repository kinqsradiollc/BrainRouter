/**
 * T4 — git/diff/review STATE + the Changes-tab git action (`runGit`), extracted
 * verbatim from App.tsx. Owns the changed-files / diff / file-view git state, the
 * per-workspace review maps (findings + gate + running flag), and the derived
 * active-workspace review views. The App calls it once and destructures every
 * symbol back so existing references (render JSX, useAgentEvents ctx) keep
 * compiling unchanged. ctx carries the App-owned bits runGit + the derived views
 * read (q, setToast, workspaces, info, changedFiles).
 */
import { useMemo, useRef, useState } from 'react';
import type { ReviewFindingView } from '../../panels/index.js';
import type { WorktreeEntry } from '../worktree/worktreeParser.js';
import { gitActionTag } from '../review/reviewGateUi.js';
import { activeEntry, reviewBadgeFor } from '../review/reviewWorkspace.js';

type ReviewView = { findings: ReviewFindingView[]; summary: string; files: number };
type GateView = { status: string; blocked: boolean; reason: string };

export interface GitStateCtx {
  q: (id: string, name: string, args?: Record<string, unknown>) => void;
  setToast: React.Dispatch<React.SetStateAction<string>>;
  workspaces: { current: string | null; recents: string[] };
  info: { sessionKey?: string; model?: string; workspaceRoot?: string; username?: string };
}

export interface GitState {
  changedFiles: Array<{ status: string; path: string }>;
  setChangedFiles: React.Dispatch<React.SetStateAction<Array<{ status: string; path: string }>>>;
  diffView: { path: string; diff: string } | null;
  setDiffView: React.Dispatch<React.SetStateAction<{ path: string; diff: string } | null>>;
  diffTarget: { path: string; line?: number } | null;
  setDiffTarget: React.Dispatch<React.SetStateAction<{ path: string; line?: number } | null>>;
  allFiles: string[];
  setAllFiles: React.Dispatch<React.SetStateAction<string[]>>;
  fileView: { path: string; content: string; error?: string } | null;
  setFileView: React.Dispatch<React.SetStateAction<{ path: string; content: string; error?: string } | null>>;
  gitInfo: { repo: string; branch: string | null; insertions: number; deletions: number; gitRoot?: string | null; repoRelativePath?: string; isSubdir?: boolean } | null;
  setGitInfo: React.Dispatch<React.SetStateAction<{ repo: string; branch: string | null; insertions: number; deletions: number; gitRoot?: string | null; repoRelativePath?: string; isSubdir?: boolean } | null>>;
  commitSubjects: string[];
  setCommitSubjects: React.Dispatch<React.SetStateAction<string[]>>;
  gitBusy: boolean;
  setGitBusy: React.Dispatch<React.SetStateAction<boolean>>;
  pendingGitRef: React.MutableRefObject<{ kind: 'commit' | 'push'; msg?: string; root: string } | null>;
  gateBlock: { kind: 'commit' | 'push'; msg?: string; reason: string; status: string } | null;
  setGateBlock: React.Dispatch<React.SetStateAction<{ kind: 'commit' | 'push'; msg?: string; reason: string; status: string } | null>>;
  worktrees: WorktreeEntry[];
  setWorktrees: React.Dispatch<React.SetStateAction<WorktreeEntry[]>>;
  worktreeDiffs: Record<string, string>;
  setWorktreeDiffs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  inlineDiffs: Record<string, string>;
  setInlineDiffs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  reviewByWs: Record<string, ReviewView | null>;
  setReviewByWs: React.Dispatch<React.SetStateAction<Record<string, ReviewView | null>>>;
  reviewGateByWs: Record<string, GateView | null>;
  setReviewGateByWs: React.Dispatch<React.SetStateAction<Record<string, GateView | null>>>;
  reviewRunningByWs: Record<string, boolean>;
  setReviewRunningByWs: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  activeRoot: string;
  review: ReviewView | null;
  reviewGate: GateView | null;
  reviewRunning: boolean;
  activeReviewBadge: ReturnType<typeof reviewBadgeFor>;
  reviewFindingsByFile: Record<string, number>;
  runGit: (kind: 'commit' | 'push' | 'pull', msg?: string, opts?: { bypass?: boolean; reviewed?: boolean }) => void;
}

export function useGitState(ctx: GitStateCtx): GitState {
  const { q, setToast, workspaces, info } = ctx;
  const [changedFiles, setChangedFiles] = useState<Array<{ status: string; path: string }>>([]);
  const [diffView, setDiffView] = useState<{ path: string; diff: string } | null>(null);
  // T3 — when "Open diff" is clicked on a review finding, remember its line so the
  // diff view scrolls/flashes to that hunk once the file-diff loads.
  const [diffTarget, setDiffTarget] = useState<{ path: string; line?: number } | null>(null);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [fileView, setFileView] = useState<{ path: string; content: string; error?: string } | null>(null);
  const [gitInfo, setGitInfo] = useState<{ repo: string; branch: string | null; insertions: number; deletions: number; gitRoot?: string | null; repoRelativePath?: string; isSubdir?: boolean } | null>(null);
  const [commitSubjects, setCommitSubjects] = useState<string[]>([]);
  // DESK-5j — Changes tab review actions (commit/push/pull via the host's
  // user-command shell path — same trust level as the terminal input row).
  const [gitBusy, setGitBusy] = useState(false);
  // Wave 4 — review gate: a pending commit/push waiting on the gate check, and
  // the block dialog shown when the gate refuses (with an explicit bypass).
  const pendingGitRef = useRef<{ kind: 'commit' | 'push'; msg?: string; root: string } | null>(null);
  const [gateBlock, setGateBlock] = useState<{ kind: 'commit' | 'push'; msg?: string; reason: string; status: string } | null>(null);
  const [inlineDiffs, setInlineDiffs] = useState<Record<string, string>>({});
  // T13 — git worktrees for this repo + a per-worktree diff cache.
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [worktreeDiffs, setWorktreeDiffs] = useState<Record<string, string>>({});
  // T12 / Review v2 + T2 multi-workspace — findings + the commit/push gate +
  // running flag, ALL keyed by workspace root so switching projects shows that
  // project's review (never leaks across workspaces). The active workspace's
  // view is derived below; the q-review-* handlers write under activeWsRef.current.
  const [reviewByWs, setReviewByWs] = useState<Record<string, ReviewView | null>>({});
  const [reviewGateByWs, setReviewGateByWs] = useState<Record<string, GateView | null>>({});
  const [reviewRunningByWs, setReviewRunningByWs] = useState<Record<string, boolean>>({});
  const activeRoot = workspaces.current ?? info.workspaceRoot ?? '';
  const review = activeEntry(reviewByWs, activeRoot);
  const reviewGate = activeEntry(reviewGateByWs, activeRoot);
  const reviewRunning = !!reviewRunningByWs[activeRoot];
  // T2 — the active project's sidebar review badge (needs/reviewing/blocked/passed/stale).
  const activeReviewBadge = reviewBadgeFor(reviewGate, changedFiles.length, reviewRunning);
  // §4 — per-file count of OPEN findings, for the Changes-list badges.
  const reviewFindingsByFile = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const f of review?.findings ?? []) if (!f.status || f.status === 'open') m[f.file] = (m[f.file] ?? 0) + 1;
    return m;
  }, [review]);

  /** DESK-5j / Wave 4 — Changes-tab git actions. commit/push are GATED by the
   *  local AI review: the gate is checked first; if it blocks, a dialog explains
   *  why and offers an explicit bypass. pull is never gated. */
  function runGit(kind: 'commit' | 'push' | 'pull', msg?: string, opts?: { bypass?: boolean; reviewed?: boolean }): void {
    // commit/push run the gate first UNLESS we're already cleared — either the
    // gate came back clean (reviewed) or the user explicitly bypassed it.
    if ((kind === 'commit' || kind === 'push') && !opts?.bypass && !opts?.reviewed) {
      // T2 — remember which workspace this action is for, so a gate result that
      // arrives after a workspace switch can't clear it in the wrong project.
      pendingGitRef.current = { kind, msg, root: workspaces.current ?? info.workspaceRoot ?? '' };
      setToast('Checking review status…');
      q('q-review-gate', 'review-gate');
      return;
    }
    const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const cmd = kind === 'commit'
      ? `git add -A && git commit -m ${sq(msg ?? '')}`
      : kind === 'push' ? 'git push' : 'git pull --ff-only';
    setGitBusy(true);
    // §7 — a CLEAN gate is "reviewed", NOT a bypass: no warning, no "bypassed" label.
    if (opts?.bypass) console.warn(`[review-gate] ${kind} BYPASSED without a clean review`);
    const state = gitActionTag(opts); // '' | 'reviewed' | 'bypassed'
    const tag = state === 'bypassed' ? ' (review bypassed)' : state === 'reviewed' ? ' (reviewed)' : '';
    setToast(kind === 'commit' ? `Committing${tag}…` : kind === 'push' ? `Pushing${tag}…` : 'Pulling…');
    q('a-git', 'action:term-exec', { cmd });
    // Wave 1 (D) — commit/push are real ACTIVITY → promote this project.
    if (kind !== 'pull') { const r = workspaces.current ?? info.workspaceRoot; if (r) void window.brainrouter.markActivity?.(r, kind); }
  }

  return {
    changedFiles, setChangedFiles, diffView, setDiffView, diffTarget, setDiffTarget,
    allFiles, setAllFiles, fileView, setFileView, gitInfo, setGitInfo, commitSubjects, setCommitSubjects,
    gitBusy, setGitBusy, pendingGitRef, gateBlock, setGateBlock,
    worktrees, setWorktrees, worktreeDiffs, setWorktreeDiffs, inlineDiffs, setInlineDiffs,
    reviewByWs, setReviewByWs, reviewGateByWs, setReviewGateByWs, reviewRunningByWs, setReviewRunningByWs,
    activeRoot, review, reviewGate, reviewRunning, activeReviewBadge, reviewFindingsByFile,
    runGit,
  };
}
