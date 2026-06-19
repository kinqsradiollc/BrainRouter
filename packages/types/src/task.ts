/**
 * BrainRouter Background Task Records (0.4.15)
 *
 * A durable, linkable record for a long-running unit of background work a
 * session launches: a plan revision triggered by requested changes, a code
 * review run, a verification run, an attachment-processing job, or a
 * delegated workflow/agent. Distinct from the *live* runtime fleet
 * (`collectRunningTasks`, which reflects in-process actors only): a
 * BackgroundTaskRecord is file-backed so it survives workspace/session
 * switches, app refresh, and host reload, and so its transcript and outcome
 * stay inspectable after the work finishes.
 *
 * Scoped by `workspaceRoot` + `sessionKey`, with optional `requirementId` /
 * `planId` / `artifactId` / `attachmentId` anchors, so the desktop can show a
 * session's tasks, a workspace's tasks, or a global active-task indicator.
 *
 * Stable, dependency-free contract shared by the CLI store, the desktop host,
 * and the agent protocol. camelCase keys, plain-`string` ids, ISO-8601
 * timestamp strings — matching the rest of this package.
 */

/** Identifier for a background task. Plain `string` alias (package convention). */
export type BackgroundTaskId = string;

/**
 * What kind of background work this record tracks.
 * - `plan-revision` — a requested-changes plan revision (gap 1).
 * - `review` — a code-review run (gap 2).
 * - `verification` — an acceptance/verification run.
 * - `attachment` — ingesting/extracting an uploaded file (gap 5).
 * - `workflow` / `agent` — a durable workflow run or delegated child agent.
 */
export type BackgroundTaskKind =
  | "plan-revision"
  | "review"
  | "verification"
  | "attachment"
  | "workflow"
  | "agent";

/** Lifecycle of a background task. */
export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/** A single progress checkpoint within a running task (phase log). */
export interface BackgroundTaskProgress {
  /** Short machine-ish phase name, e.g. `collecting-diff`, `analyzing`. */
  phase: string;
  /** Optional human note for the phase. */
  note?: string;
  /** Optional 0–100 completion estimate. */
  pct?: number;
  /** ISO-8601 timestamp the phase was entered. */
  at: string;
}

/**
 * How to open this task's conversation/transcript/workflow in the UI. `kind`
 * routes the reader (a durable task transcript, a child-agent transcript, a
 * worker transcript, or a workflow run); `id` identifies it.
 */
export interface BackgroundTaskTranscriptRef {
  kind: "task" | "agent" | "worker" | "workflow";
  id: string;
  /** Parent session key for child-agent transcripts, when needed to resolve. */
  parentSessionKey?: string;
}

export interface BackgroundTaskRecord {
  id: BackgroundTaskId;
  kind: BackgroundTaskKind;
  status: BackgroundTaskStatus;
  /** Human label shown in the task list. */
  title: string;
  /** Absolute workspace root the task belongs to. */
  workspaceRoot: string;
  /** Session that launched the task. */
  sessionKey: string;
  /** Requirement this task advances, when linked. */
  requirementId?: string;
  /** Plan / plan-decision id this task revises, when linked. */
  planId?: string;
  /** Artifact this task produced or reviews, when linked. */
  artifactId?: string;
  /** Attachment this task processes, when linked. */
  attachmentId?: string;
  /** How to open the task's transcript/conversation/workflow. */
  transcript?: BackgroundTaskTranscriptRef;
  /** Phase log, oldest-first. The last entry is the current phase. */
  progress: BackgroundTaskProgress[];
  /** Failure message when `status === "failed"`. */
  error?: string;
  /** Structured outcome (e.g. `{ findings: 3, files: 7 }`); UI-opaque. */
  result?: Record<string, unknown>;
  /** Cognitive memory record ids captured for this task (provenance). */
  linkedMemoryIds: string[];
  /** Agent-protocol / orchestration event id this record originated from. */
  sourceEventId?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp the task entered `running`, when it has. */
  startedAt?: string;
  /** ISO-8601 timestamp; bumped on every mutation. */
  updatedAt: string;
  /** ISO-8601 timestamp the task reached a terminal status, when it has. */
  completedAt?: string;
}

const BACKGROUND_TASK_KINDS: readonly BackgroundTaskKind[] = [
  "plan-revision",
  "review",
  "verification",
  "attachment",
  "workflow",
  "agent",
];

const BACKGROUND_TASK_STATUSES: readonly BackgroundTaskStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
];

/** Terminal (no longer active) statuses. */
export const TERMINAL_BACKGROUND_TASK_STATUSES: readonly BackgroundTaskStatus[] = [
  "completed",
  "failed",
  "canceled",
];

/** Narrow an unknown value to a {@link BackgroundTaskKind}. */
export function isBackgroundTaskKind(x: unknown): x is BackgroundTaskKind {
  return typeof x === "string" && (BACKGROUND_TASK_KINDS as readonly string[]).includes(x);
}

/** Narrow an unknown value to a {@link BackgroundTaskStatus}. */
export function isBackgroundTaskStatus(x: unknown): x is BackgroundTaskStatus {
  return typeof x === "string" && (BACKGROUND_TASK_STATUSES as readonly string[]).includes(x);
}

/** True when the task is still active (queued or running). */
export function isActiveBackgroundTask(status: BackgroundTaskStatus): boolean {
  return status === "queued" || status === "running";
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

function isProgressArray(x: unknown): x is BackgroundTaskProgress[] {
  return (
    Array.isArray(x) &&
    x.every(
      (v) =>
        !!v &&
        typeof v === "object" &&
        typeof (v as Record<string, unknown>).phase === "string" &&
        typeof (v as Record<string, unknown>).at === "string",
    )
  );
}

/**
 * Structural type guard for a {@link BackgroundTaskRecord}. Validates required
 * fields + enum membership so a hand-edited or foreign JSON blob is rejected
 * before it is treated as a record.
 */
export function isBackgroundTaskRecord(x: unknown): x is BackgroundTaskRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    isBackgroundTaskKind(r.kind) &&
    isBackgroundTaskStatus(r.status) &&
    typeof r.title === "string" &&
    typeof r.workspaceRoot === "string" &&
    typeof r.sessionKey === "string" &&
    (r.requirementId === undefined || typeof r.requirementId === "string") &&
    (r.planId === undefined || typeof r.planId === "string") &&
    (r.artifactId === undefined || typeof r.artifactId === "string") &&
    (r.attachmentId === undefined || typeof r.attachmentId === "string") &&
    isProgressArray(r.progress) &&
    (r.error === undefined || typeof r.error === "string") &&
    isStringArray(r.linkedMemoryIds) &&
    (r.sourceEventId === undefined || typeof r.sourceEventId === "string") &&
    typeof r.createdAt === "string" &&
    typeof r.updatedAt === "string"
  );
}

/**
 * Elapsed wall-clock for a task in ms: from `startedAt` (or `createdAt`) to
 * `completedAt` for terminal tasks, or to `now` for active ones. Pure so the
 * UI can render a live "elapsed" without owning the clock.
 */
export function backgroundTaskElapsedMs(task: BackgroundTaskRecord, now: number): number {
  const start = Date.parse(task.startedAt ?? task.createdAt);
  if (Number.isNaN(start)) return 0;
  const endIso = task.completedAt;
  const end = endIso ? Date.parse(endIso) : now;
  return Math.max(0, (Number.isNaN(end) ? now : end) - start);
}
