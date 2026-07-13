/**
 * App shell — Track mode operations. Every method issues a host `track-*` query
 * via the injected `q`. Sync completion includes the updated board, so callers
 * never race a network operation with a guessed refresh delay.
 * Extracted from App.tsx verbatim (the object literal is unchanged).
 */
import type {
  WorkItem, WorkItemType, Module, SprintState, SavedView, TrackLayout,
  AutomationRule, AutomationTrigger, AutomationAction, ProjectRole,
} from '@kinqs/brainrouter-types';

type Query = (id: string, name: string, args?: Record<string, unknown>) => void;

export function buildTrackOps(q: Query) {
  return {
    create: (input: { title: string; type: WorkItemType; status: string }) => q('q-track-create', 'track-create', input),
    transition: (idOrKey: string, toStatus: string) => q('q-track-transition', 'track-transition', { idOrKey, toStatus }),
    update: (idOrKey: string, patch: Partial<WorkItem>) => q('q-track-update-item', 'track-update-item', { idOrKey, patch }),
    comment: (idOrKey: string, body: string) => q('q-track-comment', 'track-comment', { idOrKey, body }),
    link: (idOrKey: string, input: { codeLinks?: WorkItem['codeLinks']; linkedMemoryIds?: string[]; blocks?: string }) => q('q-track-link', 'track-link', { idOrKey, ...input }),
    assignSprint: (idOrKey: string, sprintId: string | null) => q('q-track-assign-sprint', 'track-assign-sprint', { idOrKey, sprintId }),
    createSprint: (name: string, goal?: string) => q('q-track-create-sprint', 'track-create-sprint', { name, goal }),
    sprintState: (id: string, state: SprintState) => q('q-track-sprint-state', 'track-sprint-state', { id, state }),
    assignModule: (idOrKey: string, moduleId: string | null) => q('q-track-assign-module', 'track-assign-module', { idOrKey, moduleId }),
    createModule: (name: string, description?: string) => q('q-track-create-module', 'track-create-module', { name, description }),
    updateModule: (id: string, patch: Partial<Module>) => q('q-track-module-update', 'track-module-update', { id, patch }),
    deleteModule: (id: string) => q('q-track-module-delete', 'track-module-delete', { id }),
    saveView: (input: { name: string; layout: TrackLayout; query?: string; filters?: Record<string, string> }) => q('q-track-save-view', 'track-save-view', { input }),
    deleteView: (id: string) => q('q-track-delete-view', 'track-delete-view', { id }),
    createAutomation: (input: { name: string; trigger: AutomationTrigger; condition?: string; actions: AutomationAction[] }) => q('q-track-create-automation', 'track-create-automation', input),
    updateAutomation: (id: string, patch: Partial<AutomationRule>) => q('q-track-update-automation', 'track-update-automation', { id, patch }),
    deleteAutomation: (id: string) => q('q-track-delete-automation', 'track-delete-automation', { id }),
    addMember: (input: { id: string; name?: string; role: ProjectRole }) => q('q-track-add-member', 'track-add-member', input),
    updateMemberRole: (id: string, role: ProjectRole) => q('q-track-update-member-role', 'track-update-member-role', { id, role }),
    removeMember: (id: string) => q('q-track-remove-member', 'track-remove-member', { id }),
    syncMembers: () => q('q-track-sync-members', 'track-sync-members', {}),
    sync: (direction: 'import' | 'export' | 'sync', dryRun: boolean) => q('q-track-sync', 'track-sync', { direction, dryRun }),
    importGhIssues: () => q('q-track-gh-issues', 'track-gh-issues-import', {}),
    scanCommits: () => q('q-track-scan', 'track-scan-commits'),
    refreshGit: () => q('q-track-git-context', 'track-git-context'),
    startGitWork: (idOrKey: string) => q('q-track-start-work', 'track-start-work', { idOrKey }),
    refreshPr: () => q('q-track-pr-status', 'track-pr-status'),
    createDraftPr: (idOrKey: string) => q('q-track-create-pr', 'track-create-pr', { idOrKey }),
    mergePr: () => q('q-track-merge-pr', 'track-merge-pr', {}),
    submitPrReview: (decision: 'comment' | 'approve' | 'request-changes', body: string) => q('q-track-submit-pr-review', 'track-submit-pr-review', { decision, body }),
    fixFailingChecks: () => q('q-track-fix-checks', 'track-fix-failing-checks', {}),
  };
}
