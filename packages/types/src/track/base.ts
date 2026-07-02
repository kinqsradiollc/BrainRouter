/**
 * TRACK types — base scalars, id aliases, literal unions + their rank/color registries.
 */
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
export type ModuleId = string;
export type BoardId = string;
export type CommentId = string;
export type LabelId = string;
export type SavedViewId = string;

// ── Enums ───────────────────────────────────────────────────────────────────

/**
 * The core work-item types. `epic` is the umbrella (children link via
 * {@link WorkItem.epicId}); `sub-task` is a child of another item (via
 * {@link WorkItem.parentId}). Project-defined custom types are a later slice.
 */
export type WorkItemType = "epic" | "story" | "task" | "bug" | "sub-task";

/**
 * The lifecycle group a workflow state rolls up to. A project may define many
 * named states, but each maps to exactly one group so boards and velocity/flow
 * reports have a stable model. `triage` is the intake lane; `cancelled` and
 * `completed` are both terminal (and both close a linked GitHub issue).
 */
export type StatusCategory =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "cancelled"
  | "triage";

/** Priority, ordered urgent (highest) → none (lowest). Default is `none`. */
export type WorkItemPriority = "urgent" | "high" | "medium" | "low" | "none";

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
  | "duplicated-by"
  | "start-before"
  | "start-after"
  | "finish-before"
  | "finish-after"
  | "implements"
  | "implemented-by";

/** Kind of code artifact a work item is linked to. */
export type CodeLinkKind = "branch" | "commit" | "pull-request" | "file";

const WORK_ITEM_TYPES: readonly WorkItemType[] = ["epic", "story", "task", "bug", "sub-task"];
const STATUS_CATEGORIES: readonly StatusCategory[] = ["backlog", "unstarted", "started", "completed", "cancelled", "triage"];
const WORK_ITEM_PRIORITIES: readonly WorkItemPriority[] = ["urgent", "high", "medium", "low", "none"];

/**
 * Priority rank for ordering and `priority >`/`<` queries — higher is more
 * urgent. Shared by the store, the query language, and the desktop sort so the
 * ordering never drifts between layers.
 */
export const PRIORITY_RANK: Record<WorkItemPriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

/**
 * Terminal lifecycle groups — an item in one of these is "closed" (and a linked
 * GitHub issue is closed to match). Used by reports and the GitHub state mapping.
 */
export const TERMINAL_STATUS_CATEGORIES: readonly StatusCategory[] = ["completed", "cancelled"];

/** Closed/terminal (completed or cancelled) — maps to a closed GitHub issue. */
export function isTerminalCategory(c: StatusCategory): boolean {
  return c === "completed" || c === "cancelled";
}

/** Work has not begun yet (backlog or unstarted) — eligible for "work started" auto-advance. */
export function isUnstartedCategory(c: StatusCategory): boolean {
  return c === "backlog" || c === "unstarted";
}
const SPRINT_STATES: readonly SprintState[] = ["future", "active", "completed"];
const BOARD_TYPES: readonly BoardType[] = ["kanban", "scrum"];
const WORK_ITEM_LINK_TYPES: readonly WorkItemLinkType[] = [
  "blocks",
  "blocked-by",
  "relates-to",
  "duplicates",
  "duplicated-by",
  "start-before",
  "start-after",
  "finish-before",
  "finish-after",
  "implements",
  "implemented-by",
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

