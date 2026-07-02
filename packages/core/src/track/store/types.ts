/**
 * TRACK store — public record/input types.
 *
 * The externally-referenced type surface of the Track store (mirror snapshots,
 * external links, sync targets, and the CRUD input shapes). Kept in a leaf
 * module so both the store internals and the GitHub sync bridge can share them
 * without a circular import.
 */
import type {
  WorkItemType,
  WorkItemPriority,
  WorkItem,
  WorkItemLink,
  CodeLink,
  Sprint,
  Module,
  ModuleStatus,
  TrackLayout,
  BoardType,
  BoardColumn,
  AutomationTrigger,
  AutomationAction,
  AutomationRule,
  ProjectRole,
} from '@kinqs/brainrouter-types';

/**
 * Snapshot of the GitHub-mirrored fields at the last successful sync. Serves as
 * the common ancestor ("base") for a 3-way merge, so a two-way sync can tell a
 * LOCAL edit from a REMOTE edit and only overwrite a field that the *other* side
 * changed — instead of GitHub always clobbering local (or vice-versa).
 */
export interface GithubMirrorSnapshot {
  title: string;
  description: string;
  type: string;
  priority: string;
  /** Plain labels only (the synthetic `type:` / `priority:` labels are excluded). */
  labels: string[];
  assignees: string[];
  /** GitHub issue state as a boolean: closed ⇔ a terminal (completed/cancelled) category. */
  closed: boolean;
}

/** A recorded link from a work item to an external system's record. */
export interface ExternalLink {
  number: number;
  url: string;
  /** 3-way-merge base captured at the last sync (bidirectional sync). */
  baseline?: GithubMirrorSnapshot;
  /** The issue's `updated_at` at the last sync (cheap "did GitHub change?" hint). */
  githubUpdatedAt?: string;
  /** ISO timestamp of the last sync. */
  syncedAt?: string;
}

/** The workspace's active GitHub sync target: which connector + which repo. */
export interface GithubSyncTarget { connectorId: string; repo: string }

export interface EnsureProjectInput {
  name?: string;
  key?: string;
}

export interface CreateWorkItemInput {
  title: string;
  type?: WorkItemType;
  description?: string;
  status?: string;
  priority?: WorkItemPriority;
  /** Primary assignee (legacy single field; folded into `assignees`). */
  assignee?: string;
  /** Multiple assignees (the source of truth). */
  assignees?: string[];
  reporter?: string;
  labels?: string[];
  components?: string[];
  storyPoints?: number;
  startDate?: string;
  targetDate?: string;
  parentId?: string;
  epicId?: string;
  sprintId?: string;
  moduleId?: string;
  sessionKey?: string;
  requirementId?: string;
  codeLinks?: CodeLink[];
  /** Who created it (a username, or `agent`/`auto`). */
  actor?: string;
}

export interface WorkItemFilter {
  type?: WorkItemType;
  status?: string;
  statusCategory?: import('@kinqs/brainrouter-types').StatusCategory;
  assignee?: string;
  sprintId?: string;
  moduleId?: string;
  epicId?: string;
  parentId?: string;
  label?: string;
  /** Substring match over key + title (case-insensitive). */
  text?: string;
  /** A JQL-style query (see query.ts). A malformed query matches nothing. */
  query?: string;
  /** Include archived items (excluded by default, matching the default board/list view). */
  includeArchived?: boolean;
}

/** Fields a caller may patch. Status changes recompute the category + completedAt. */
export type UpdateWorkItemPatch = Partial<
  Pick<
    WorkItem,
    | 'title' | 'description' | 'status' | 'priority' | 'assignee' | 'assignees' | 'reporter'
    | 'labels' | 'components' | 'storyPoints' | 'estimateSeconds' | 'startDate' | 'targetDate'
    | 'parentId' | 'epicId' | 'sprintId' | 'moduleId' | 'rank'
  >
>;

/** Optional external provenance for a synced comment (e.g. a GitHub issue comment). */
export interface CommentExternal { externalSource: string; externalId: string }

export interface LinkWorkItemInput {
  codeLinks?: CodeLink[];
  links?: WorkItemLink[];
  linkedMemoryIds?: string[];
  taskIds?: string[];
  artifactIds?: string[];
  reviewFindingIds?: string[];
  watchers?: string[];
}

export interface CreateSprintInput {
  name: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  capacity?: number;
}

export type UpdateSprintPatch = Partial<Pick<Sprint, 'name' | 'goal' | 'startDate' | 'endDate' | 'capacity' | 'velocity'>>;

export interface CreateModuleInput {
  name: string;
  description?: string;
  status?: ModuleStatus;
  lead?: string;
  members?: string[];
  startDate?: string;
  targetDate?: string;
}

export type UpdateModulePatch = Partial<Pick<Module, 'name' | 'description' | 'status' | 'lead' | 'members' | 'startDate' | 'targetDate'>>;

export interface SaveViewInput {
  name: string;
  layout: TrackLayout;
  query?: string;
  filters?: Record<string, string>;
  groupBy?: string;
  orderBy?: string;
}

export interface CreateBoardInput {
  name: string;
  type?: BoardType;
  columns?: BoardColumn[];
  swimlaneField?: string;
  filter?: string;
}

export interface CreateAutomationInput {
  name: string;
  trigger: AutomationTrigger;
  condition?: string;
  actions: AutomationAction[];
  enabled?: boolean;
}

export type AutomationPatch = Partial<Pick<AutomationRule, 'name' | 'enabled' | 'trigger' | 'condition' | 'actions'>>;

export interface AddMemberInput {
  id: string;
  name?: string;
  role?: ProjectRole;
}

export interface UpsertLabelInput {
  name: string;
  color?: string;
  description?: string;
  externalSource?: string;
  externalId?: string;
}
