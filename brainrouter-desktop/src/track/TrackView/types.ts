/**
 * Track view — shared types, ops surface, and small constants used across the
 * Track sub-views. Split out of TrackView.tsx (behavior-preserving) so the view
 * modules and external consumers share one source of truth.
 */
import type { WorkItem, WorkItemType, WorkItemPriority, SprintState, Module, TrackLayout, AutomationRule, AutomationTrigger, AutomationAction, ProjectRole } from '@kinqs/brainrouter-types';

// External sync (GitHub) — view-side shapes mirroring core's githubSync results.
export interface SyncRepoConfig { repo: string; hasToken: boolean; tokenSource: string | null; active?: boolean; label?: string | null; source?: string | null; connectorId?: string | null }
export interface SyncConfig { repo: string | null; hasToken: boolean; tokenSource: string | null; repos?: SyncRepoConfig[]; caBundle?: string | null }
export interface SyncRow { key?: string; issueNumber?: number; title: string; action: 'create' | 'update' }
export interface SyncResult { direction: 'export' | 'import' | 'sync'; dryRun: boolean; exported?: SyncRow[]; imported?: SyncRow[]; pushed?: number; pulled?: number; created?: { local: number; remote: number }; conflicts?: Array<{ key: string; field: string }>; errors: string[] }
export interface GitTrackRemote { name: string; url: string; githubRepo?: string }
export interface GitTrackContext {
  ok: boolean;
  hasGit: boolean;
  root?: string;
  currentBranch?: string | null;
  remotes: GitTrackRemote[];
  githubRepo?: string;
  error?: string;
}
export interface TrackPrStatus {
  pr: { number?: number; state?: string; title?: string; url?: string; headRefName?: string; baseRefName?: string; isDraft?: boolean; mergeable?: string; statusCheckRollup?: unknown[] } | null;
  branch: string | null;
  itemKey?: string;
  error?: string;
}

export const TYPE_ICON: Record<WorkItemType, string> = {
  epic: 'spark', story: 'review', task: 'check-circle', bug: 'warn', 'sub-task': 'tasks',
};
export const PRIORITY_RANK: Record<WorkItemPriority, number> = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };

export interface TrackOps {
  create: (input: { title: string; type: WorkItemType; status: string }) => void;
  transition: (idOrKey: string, toStatus: string) => void;
  update: (idOrKey: string, patch: Partial<WorkItem>) => void;
  comment: (idOrKey: string, body: string) => void;
  link: (idOrKey: string, input: { codeLinks?: WorkItem['codeLinks']; linkedMemoryIds?: string[]; blocks?: string }) => void;
  assignSprint: (idOrKey: string, sprintId: string | null) => void;
  createSprint: (name: string, goal?: string) => void;
  sprintState: (id: string, state: SprintState) => void;
  assignModule: (idOrKey: string, moduleId: string | null) => void;
  createModule: (name: string, description?: string) => void;
  updateModule: (id: string, patch: Partial<Module>) => void;
  deleteModule: (id: string) => void;
  saveView: (input: { name: string; layout: TrackLayout; query?: string; filters?: Record<string, string> }) => void;
  deleteView: (id: string) => void;
  createAutomation: (input: { name: string; trigger: AutomationTrigger; condition?: string; actions: AutomationAction[] }) => void;
  updateAutomation: (id: string, patch: Partial<AutomationRule>) => void;
  deleteAutomation: (id: string) => void;
  addMember: (input: { id: string; name?: string; role: ProjectRole }) => void;
  updateMemberRole: (id: string, role: ProjectRole) => void;
  removeMember: (id: string) => void;
  syncMembers: () => void;
  sync: (direction: 'import' | 'export' | 'sync', dryRun: boolean) => void;
  importGhIssues: () => void;
  scanCommits: () => void;
  refreshGit: () => void;
  startGitWork: (idOrKey: string) => void;
  refreshPr: () => void;
  createDraftPr: (idOrKey: string) => void;
  mergePr: () => void;
  submitPrReview: (decision: 'comment' | 'approve' | 'request-changes', body: string) => void;
  fixFailingChecks: () => void;
}
