/**
 * TRACK types — default workflow states / issue types / status colors.
 */
import type { StatusCategory } from "./base.js";
import type { IssueTypeConfig, WorkflowState } from "./entities.js";
/**
 * The default workflow a new project starts with: Backlog → Todo → In Progress
 * → Done, plus a terminal Cancelled lane. New items default into Backlog.
 */
export const DEFAULT_WORKFLOW_STATES: readonly WorkflowState[] = [
  { id: "backlog", name: "Backlog", category: "backlog", color: "#94a3b8", default: true },
  { id: "todo", name: "Todo", category: "unstarted", color: "#64748b" },
  { id: "in-progress", name: "In Progress", category: "started", color: "#f59e0b" },
  { id: "in-review", name: "In Review", category: "started", color: "#6366f1" },
  { id: "done", name: "Done", category: "completed", color: "#22c55e" },
  { id: "cancelled", name: "Cancelled", category: "cancelled", color: "#9ca3af" },
];

/** Default hex swatch for a lifecycle group (migration backfill + new custom states). */
export const STATUS_CATEGORY_COLORS: Record<StatusCategory, string> = {
  backlog: "#94a3b8",
  unstarted: "#64748b",
  started: "#f59e0b",
  completed: "#22c55e",
  cancelled: "#9ca3af",
  triage: "#a855f7",
};

/** The default issue types a new project enables. */
export const DEFAULT_ISSUE_TYPES: readonly IssueTypeConfig[] = [
  { type: "epic", name: "Epic" },
  { type: "story", name: "Story" },
  { type: "task", name: "Task" },
  { type: "bug", name: "Bug" },
  { type: "sub-task", name: "Sub-task", subtask: true },
];

