/**
 * Git service (ADR-008, Wave 2) — a stateless port over the read-only git
 * helpers (root/head resolution, workspace-git scoping, churn signal). Additive
 * and behaviour-preserving: every method delegates to the existing
 * workspaceGit / gitChurn functions. No logic moved or removed.
 */
import {
  findGitRoot, gitHeadSha, resolveWorkspaceGit, workspaceGitScope, type WorkspaceGitInfo,
} from "./workspaceGit.js";
import { gitChurnSignal, type ChurnSignal } from "./gitChurn.js";

/** The read-only git helpers contract. */
export interface IGitService {
  findRoot(dir: string): string | null;
  headSha(dir: string): string | undefined;
  resolveWorkspace(selectedRoot: string): WorkspaceGitInfo;
  scope(info: WorkspaceGitInfo): { cwd: string; pathspec: string[] };
  churnSignal(repoRoot: string, filePath: string): ChurnSignal;
}

/** {@link IGitService} backed by the in-process git helpers — delegates only. */
export class GitService implements IGitService {
  findRoot(dir: string): string | null {
    return findGitRoot(dir);
  }
  headSha(dir: string): string | undefined {
    return gitHeadSha(dir);
  }
  resolveWorkspace(selectedRoot: string): WorkspaceGitInfo {
    return resolveWorkspaceGit(selectedRoot);
  }
  scope(info: WorkspaceGitInfo): { cwd: string; pathspec: string[] } {
    return workspaceGitScope(info);
  }
  churnSignal(repoRoot: string, filePath: string): ChurnSignal {
    return gitChurnSignal(repoRoot, filePath);
  }
}

/** Construct a git service. */
export function createGitService(): IGitService {
  return new GitService();
}
