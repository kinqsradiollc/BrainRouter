/**
 * BrainRouter Track — project-management records (0.4.x · unified workspace)
 *
 * Track is the project-management mode of the unified workspace (Chat · Track ·
 * Code). **Each workspace is one project** ({@link TrackProject}), holding its
 * key prefix, configurable workflow states, and issue types. Work is modelled as
 * {@link WorkItem}s (issue/story/bug/task/sub-task/epic) organised into
 * {@link Sprint}s and shown on {@link Board}s.
 *
 * Like the rest of this package, this module is the stable, dependency-free
 * contract shared by the durable store, the agent tools, the CLI, and the
 * desktop panel. Field casing follows the package convention — camelCase keys,
 * plain-`string` ids, ISO-8601 timestamp strings — and every enum ships a
 * `readonly` member list + an `is*` type guard.
 */

// ── Id aliases (plain `string`, matching the rest of the package) ───────────

export type ProjectId = string;
export type WorkItemId = string;
export type SprintId = string;
export type BoardId = string;
export type CommentId = string;

// ── Enums ───────────────────────────────────────────────────────────────────

/**
 * The core work-item types. `epic` is the umbrella (children link via
 * {@link WorkItem.epicId}); `sub-task` is a child of another item (via
 * {@link WorkItem.parentId}). Project-defined custom types are a later slice.
 */
export type WorkItemType = "epic" | "story" | "task" | "bug" | "sub-task";

/**
 * The board/report bucket a workflow state rolls up to. A project may define
 * many named states, but each maps to exactly one category so boards and
 * velocity/flow reports have a stable three-lane model.
 */
export type StatusCategory = "todo" | "in-progress" | "done";

/** Five-level priority, ordered lowest → highest. */
export type WorkItemPriority = "lowest" | "low" | "medium" | "high" | "highest";

/** Sprint lifecycle. */
export type SprintState = "future" | "active" | "completed";

/** Board flavour. */
export type BoardType = "kanban" | "scrum";

/** Directed relationship between two work items. */
export type WorkItemLinkType =
  | "blocks"
  | "blocked-by"
  | "relates-to"
  | "duplicates"
  | "duplicated-by";

/** Kind of code artifact a work item is linked to. */
export type CodeLinkKind = "branch" | "commit" | "pull-request" | "file";

const WORK_ITEM_TYPES: readonly WorkItemType[] = ["epic", "story", "task", "bug", "sub-task"];
const STATUS_CATEGORIES: readonly StatusCategory[] = ["todo", "in-progress", "done"];
const WORK_ITEM_PRIORITIES: readonly WorkItemPriority[] = ["lowest", "low", "medium", "high", "highest"];
const SPRINT_STATES: readonly SprintState[] = ["future", "active", "completed"];
const BOARD_TYPES: readonly BoardType[] = ["kanban", "scrum"];
const WORK_ITEM_LINK_TYPES: readonly WorkItemLinkType[] = [
  "blocks",
  "blocked-by",
  "relates-to",
  "duplicates",
  "duplicated-by",
];
const CODE_LINK_KINDS: readonly CodeLinkKind[] = ["branch", "commit", "pull-request", "file"];

export function isWorkItemType(x: unknown): x is WorkItemType {
  return typeof x === "string" && (WORK_ITEM_TYPES as readonly string[]).includes(x);
}
export function isStatusCategory(x: unknown): x is StatusCategory {
  return typeof x === "string" && (STATUS_CATEGORIES as readonly string[]).includes(x);
}
export function isWorkItemPriority(x: unknown): x is WorkItemPriority {
  return typeof x === "string" && (WORK_ITEM_PRIORITIES as readonly string[]).includes(x);
}
export function isSprintState(x: unknown): x is SprintState {
  return typeof x === "string" && (SPRINT_STATES as readonly string[]).includes(x);
}
export function isBoardType(x: unknown): x is BoardType {
  return typeof x === "string" && (BOARD_TYPES as readonly string[]).includes(x);
}
export function isWorkItemLinkType(x: unknown): x is WorkItemLinkType {
  return typeof x === "string" && (WORK_ITEM_LINK_TYPES as readonly string[]).includes(x);
}
export function isCodeLinkKind(x: unknown): x is CodeLinkKind {
  return typeof x === "string" && (CODE_LINK_KINDS as readonly string[]).includes(x);
}

// ── Project configuration ─────────────────────────────────────────────────────

/** One state in a project's configurable workflow. */
export interface WorkflowState {
  /** Stable id used by work items + board columns (e.g. "in-review"). */
  id: string;
  /** Human label (e.g. "In Review"). */
  name: string;
  /** Board/report bucket this state rolls up to. */
  category: StatusCategory;
}

/** One configurable issue type for a project. */
export interface IssueTypeConfig {
  type: WorkItemType;
  /** Display name (defaults to a capitalised `type`). */
  name?: string;
  /** True for `sub-task` and any type that must have a parent. */
  subtask?: boolean;
}

/**
 * A Track project — one per workspace. Holds the key prefix used to mint
 * human work-item keys (`<prefix>-<n>`), the ordered workflow states, the
 * enabled issue types, and the component list.
 */
export interface TrackProject {
  id: ProjectId;
  /** Absolute workspace root this project belongs to (the project's identity). */
  workspaceRoot: string;
  /** Human project name. */
  name: string;
  /** Key prefix for minted work-item keys, e.g. "BR" → "BR-123". */
  key: string;
  /** Monotonic counter for the next work-item key (`<key>-<counter>`). */
  keyCounter: number;
  /** Ordered workflow states (the columns flow left→right by default). */
  workflowStates: WorkflowState[];
  /** Enabled issue types. */
  issueTypes: IssueTypeConfig[];
  /** Component / area labels for grouping work. */
  components: string[];
  /** Project members + their roles (see {@link ProjectMember}). Seeded with one owner. */
  members: ProjectMember[];
  createdAt: string;
  updatedAt: string;
}

// ── Work items ────────────────────────────────────────────────────────────────

/** A link from a work item to a code artifact (the code-aware differentiator). */
export interface CodeLink {
  kind: CodeLinkKind;
  /** Branch name · commit sha · PR url/number · workspace-relative file path. */
  ref: string;
  /** Optional human label. */
  label?: string;
}

/** A directed dependency/relationship to another work item. */
export interface WorkItemLink {
  type: WorkItemLinkType;
  /** The other work item's id. */
  targetId: WorkItemId;
}

/** A comment on a work item. */
export interface WorkItemComment {
  id: CommentId;
  author: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
}

/** One append-only entry in a work item's activity log. */
export interface WorkItemActivity {
  /** ISO-8601 timestamp of the change. */
  at: string;
  /** Who made the change (a username, or `agent` / `auto`). */
  actor: string;
  /** The field that changed (e.g. "status", "assignee"), or "created". */
  field: string;
  from?: string;
  to?: string;
}

/**
 * The unit of work. `status` is a project-defined {@link WorkflowState} id;
 * `statusCategory` denormalises its bucket so boards/reports don't have to
 * resolve the project on every read. Provenance fields tie the item back to the
 * workspace, the chat session, BrainRouter memory, the code it touches, and the
 * existing requirement → plan → task → review flow.
 */
export interface WorkItem {
  id: WorkItemId;
  /** Human key, `<projectKey>-<n>` (e.g. "BR-123"). */
  key: string;
  type: WorkItemType;
  title: string;
  description?: string;
  /** A {@link WorkflowState.id} defined by the owning project. */
  status: string;
  /** Bucket of `status`, denormalised for boards + reports. */
  statusCategory: StatusCategory;
  priority: WorkItemPriority;
  assignee?: string;
  reporter?: string;
  watchers: string[];
  labels: string[];
  components: string[];
  /** Story-point estimate (scrum). */
  storyPoints?: number;
  /** Time estimate in seconds (kanban/time-tracking). */
  estimateSeconds?: number;
  /** ISO-8601 due date. */
  dueDate?: string;
  /** Parent work item, for a `sub-task`. */
  parentId?: WorkItemId;
  /** The epic this item belongs to. */
  epicId?: WorkItemId;
  /** The sprint this item is committed to. */
  sprintId?: SprintId;
  /** Fractional rank string for stable board/backlog ordering. */
  rank?: string;
  /** Dependencies / relationships to other items. */
  links: WorkItemLink[];
  comments: WorkItemComment[];
  /** Attachment ids (reuses the shared attachment store). */
  attachmentIds: string[];
  /** Append-only change history. */
  activity: WorkItemActivity[];

  // ── Provenance ──────────────────────────────────────────────────────────
  /** Absolute workspace root (= the owning project). */
  workspaceRoot: string;
  /** Chat session this item was created from, when known. */
  sessionKey?: string;
  /** Cognitive memory record ids captured for this item. */
  linkedMemoryIds: string[];
  /** Links to branches / commits / PRs / files. */
  codeLinks: CodeLink[];
  /** The requirement this item realises, if any. */
  requirementId?: string;
  /** Plan/task ids this item maps onto. */
  taskIds: string[];
  /** Workflow-artifact ids linked to this item. */
  artifactIds: string[];
  /** Review-finding ids that produced or relate to this item. */
  reviewFindingIds: string[];

  createdAt: string;
  /** Bumped on every mutation. */
  updatedAt: string;
}

// ── Sprints + boards ──────────────────────────────────────────────────────────

export interface Sprint {
  id: SprintId;
  workspaceRoot: string;
  name: string;
  goal?: string;
  state: SprintState;
  /** ISO-8601 start/end (set when planned/started). */
  startDate?: string;
  endDate?: string;
  /** Capacity in story points or hours (project's unit). */
  capacity?: number;
  /** Completed story points captured when the sprint is closed. */
  velocity?: number;
  createdAt: string;
  updatedAt: string;
}

/** One column on a board, mapping to one or more workflow states. */
export interface BoardColumn {
  name: string;
  /** Workflow-state ids this column collects. */
  stateIds: string[];
  /** Optional work-in-progress limit. */
  wipLimit?: number;
}

export interface Board {
  id: BoardId;
  workspaceRoot: string;
  name: string;
  type: BoardType;
  columns: BoardColumn[];
  /** Field a board swims lanes by (e.g. "assignee", "epicId"), if any. */
  swimlaneField?: string;
  /** Saved filter/query string scoping the board's items (P5: JQL-style). */
  filter?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Automation rules ──────────────────────────────────────────────────────────

/** When an automation rule fires. */
export type AutomationTrigger = "created" | "transitioned" | "updated";

/** What an automation rule does when it fires. */
export type AutomationActionType = "set-status" | "set-priority" | "set-assignee" | "add-label" | "comment";

export interface AutomationAction {
  type: AutomationActionType;
  /** Status id · priority · assignee · label · comment body, per `type`. */
  value: string;
}

/**
 * A per-project automation rule: when a work item hits `trigger` and matches the
 * optional JQL `condition`, run the `actions`. Actions are applied directly (they
 * do not re-trigger automation) so rules can't loop.
 */
export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  /** Optional JQL query the item must match (see track query). Empty = always. */
  condition?: string;
  actions: AutomationAction[];
  createdAt: string;
  updatedAt: string;
}

const AUTOMATION_TRIGGERS: readonly AutomationTrigger[] = ["created", "transitioned", "updated"];
const AUTOMATION_ACTION_TYPES: readonly AutomationActionType[] = ["set-status", "set-priority", "set-assignee", "add-label", "comment"];

export function isAutomationTrigger(x: unknown): x is AutomationTrigger {
  return typeof x === "string" && (AUTOMATION_TRIGGERS as readonly string[]).includes(x);
}
export function isAutomationActionType(x: unknown): x is AutomationActionType {
  return typeof x === "string" && (AUTOMATION_ACTION_TYPES as readonly string[]).includes(x);
}

// ── Members & permissions ─────────────────────────────────────────────────────

/** A member's role on a project, ordered least → most privileged. */
export type ProjectRole = "viewer" | "member" | "admin" | "owner";

/**
 * A permission-checkable capability. The board read is `view`; everything else
 * is a write/admin action. Roles map to a minimum rank (see {@link roleCan}).
 */
export type ProjectCapability =
  | "view"
  | "create-item"
  | "edit-item"
  | "delete-item"
  | "manage-sprints"
  | "manage-automation"
  | "manage-members";

/** One member of a project. `id` is a stable handle (username/email). */
export interface ProjectMember {
  /** Stable handle used as the activity-log actor and permission subject. */
  id: string;
  /** Display name (defaults to `id`). */
  name?: string;
  role: ProjectRole;
  /** ISO-8601 timestamp the member was added. */
  addedAt: string;
}

const PROJECT_ROLES: readonly ProjectRole[] = ["viewer", "member", "admin", "owner"];
/** Privilege rank — higher beats lower. */
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
/** The minimum role rank each capability requires. */
const CAPABILITY_MIN_RANK: Record<ProjectCapability, number> = {
  view: 0,            // viewer+
  "create-item": 1,   // member+
  "edit-item": 1,     // member+
  "manage-sprints": 1,// member+
  "delete-item": 2,   // admin+
  "manage-automation": 2, // admin+
  "manage-members": 2,    // admin+
};

export function isProjectRole(x: unknown): x is ProjectRole {
  return typeof x === "string" && (PROJECT_ROLES as readonly string[]).includes(x);
}

/** Pure policy: may a member with `role` perform `capability`? Shared by store, CLI, and UI. */
export function roleCan(role: ProjectRole, capability: ProjectCapability): boolean {
  return ROLE_RANK[role] >= CAPABILITY_MIN_RANK[capability];
}

// ── Type guards for the durable records ───────────────────────────────────────

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

/** Structural guard for a {@link TrackProject}. */
export function isTrackProject(x: unknown): x is TrackProject {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.workspaceRoot === "string" &&
    typeof p.name === "string" &&
    typeof p.key === "string" &&
    typeof p.keyCounter === "number" &&
    Array.isArray(p.workflowStates) &&
    (p.workflowStates as unknown[]).every(
      (s) =>
        !!s &&
        typeof s === "object" &&
        typeof (s as WorkflowState).id === "string" &&
        typeof (s as WorkflowState).name === "string" &&
        isStatusCategory((s as WorkflowState).category),
    ) &&
    Array.isArray(p.issueTypes) &&
    (p.issueTypes as unknown[]).every((t) => !!t && typeof t === "object" && isWorkItemType((t as IssueTypeConfig).type)) &&
    isStringArray(p.components) &&
    typeof p.createdAt === "string" &&
    typeof p.updatedAt === "string"
  );
}

/** Structural guard for a {@link WorkItem} (validates the required core fields). */
export function isWorkItem(x: unknown): x is WorkItem {
  if (!x || typeof x !== "object") return false;
  const w = x as Record<string, unknown>;
  return (
    typeof w.id === "string" &&
    typeof w.key === "string" &&
    isWorkItemType(w.type) &&
    typeof w.title === "string" &&
    typeof w.status === "string" &&
    isStatusCategory(w.statusCategory) &&
    isWorkItemPriority(w.priority) &&
    isStringArray(w.watchers) &&
    isStringArray(w.labels) &&
    isStringArray(w.components) &&
    Array.isArray(w.links) &&
    Array.isArray(w.comments) &&
    isStringArray(w.attachmentIds) &&
    Array.isArray(w.activity) &&
    typeof w.workspaceRoot === "string" &&
    isStringArray(w.linkedMemoryIds) &&
    Array.isArray(w.codeLinks) &&
    isStringArray(w.taskIds) &&
    isStringArray(w.artifactIds) &&
    isStringArray(w.reviewFindingIds) &&
    typeof w.createdAt === "string" &&
    typeof w.updatedAt === "string"
  );
}

/** Structural guard for a {@link Sprint}. */
export function isSprint(x: unknown): x is Sprint {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.workspaceRoot === "string" &&
    typeof s.name === "string" &&
    isSprintState(s.state) &&
    typeof s.createdAt === "string" &&
    typeof s.updatedAt === "string"
  );
}

/** Structural guard for a {@link Board}. */
export function isBoard(x: unknown): x is Board {
  if (!x || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    typeof b.id === "string" &&
    typeof b.workspaceRoot === "string" &&
    typeof b.name === "string" &&
    isBoardType(b.type) &&
    Array.isArray(b.columns) &&
    (b.columns as unknown[]).every(
      (c) => !!c && typeof c === "object" && typeof (c as BoardColumn).name === "string" && isStringArray((c as BoardColumn).stateIds),
    ) &&
    typeof b.createdAt === "string" &&
    typeof b.updatedAt === "string"
  );
}

// ── Defaults ──────────────────────────────────────────────────────────────────

/** The default workflow a new project starts with (To Do → In Progress → In Review → Done). */
export const DEFAULT_WORKFLOW_STATES: readonly WorkflowState[] = [
  { id: "todo", name: "To Do", category: "todo" },
  { id: "in-progress", name: "In Progress", category: "in-progress" },
  { id: "in-review", name: "In Review", category: "in-progress" },
  { id: "done", name: "Done", category: "done" },
];

/** The default issue types a new project enables. */
export const DEFAULT_ISSUE_TYPES: readonly IssueTypeConfig[] = [
  { type: "epic", name: "Epic" },
  { type: "story", name: "Story" },
  { type: "task", name: "Task" },
  { type: "bug", name: "Bug" },
  { type: "sub-task", name: "Sub-task", subtask: true },
];
