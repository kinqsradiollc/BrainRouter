/**
 * BrainRouter Artifact Records (0.4.15)
 *
 * An Artifact is a durable, linkable record for a workflow output a session
 * produces or reviews: a design note, an implementation sketch, an HTML
 * prototype, a markdown report, a verification summary, or a review export.
 * The content lives either as a workspace-relative file (`path`) or inline
 * (`content`) for small/no-file artifacts; metadata + provenance link it back
 * to the requirement / task / session / memory it belongs to.
 *
 * This is distinct from workflow-RUN output files (the CLI's workflowArtifacts):
 * those are the raw files a programmable workflow writes; an ArtifactRecord is
 * a first-class, browsable, annotatable record in the requirement-first
 * workflow.
 *
 * Stable, dependency-free contract shared by the CLI store (and, in later
 * slices, the desktop panel + MCP tools). camelCase keys, plain-`string` ids,
 * ISO-8601 timestamp strings — matching the rest of this package.
 */

/** Identifier for an artifact. Plain `string` alias (the package convention). */
export type ArtifactId = string;

/** What kind of artifact this is. `other` is the escape hatch. */
export type ArtifactKind =
  | "design-note"
  | "sketch"
  | "html-prototype"
  | "markdown-report"
  | "verification-summary"
  | "review-export"
  | "other";

/** Lifecycle of an artifact: a working `draft`, a `final` deliverable, or `archived`. */
export type ArtifactStatus = "draft" | "final" | "archived";

/** How the artifact's content should be rendered/previewed. */
export type ArtifactFormat = "markdown" | "html" | "text";

export interface ArtifactRecord {
  id: ArtifactId;
  kind: ArtifactKind;
  title: string;
  status: ArtifactStatus;
  format: ArtifactFormat;
  /** Workspace-relative path when the artifact is a file on disk. */
  path?: string;
  /** Inline content when the artifact is small or has no backing file. */
  content?: string;
  /** A short human summary of what the artifact is. */
  summary?: string;
  /** Absolute workspace root the artifact belongs to. */
  workspaceRoot: string;
  /** Session this artifact was produced in, when known. */
  sessionKey?: string;
  /** Requirement this artifact supports, when linked. */
  requirementId?: string;
  /** Task this artifact was produced by, when linked. */
  taskId?: string;
  /** Cognitive memory record ids captured for this artifact. */
  linkedMemoryIds: string[];
  /** Agent-protocol / orchestration event id this record originated from, if any. */
  sourceEventId?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp; bumped on every mutation. */
  updatedAt: string;
}

const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "design-note",
  "sketch",
  "html-prototype",
  "markdown-report",
  "verification-summary",
  "review-export",
  "other",
];

const ARTIFACT_STATUSES: readonly ArtifactStatus[] = ["draft", "final", "archived"];

const ARTIFACT_FORMATS: readonly ArtifactFormat[] = ["markdown", "html", "text"];

/** Narrow an unknown value to an {@link ArtifactKind}. */
export function isArtifactKind(x: unknown): x is ArtifactKind {
  return typeof x === "string" && (ARTIFACT_KINDS as readonly string[]).includes(x);
}

/** Narrow an unknown value to an {@link ArtifactStatus}. */
export function isArtifactStatus(x: unknown): x is ArtifactStatus {
  return typeof x === "string" && (ARTIFACT_STATUSES as readonly string[]).includes(x);
}

/** Narrow an unknown value to an {@link ArtifactFormat}. */
export function isArtifactFormat(x: unknown): x is ArtifactFormat {
  return typeof x === "string" && (ARTIFACT_FORMATS as readonly string[]).includes(x);
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

/**
 * Structural type guard for an {@link ArtifactRecord}. Validates the required
 * fields + enum membership so a hand-edited or foreign JSON blob is rejected
 * before it is treated as a record.
 */
export function isArtifactRecord(x: unknown): x is ArtifactRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    isArtifactKind(r.kind) &&
    typeof r.title === "string" &&
    isArtifactStatus(r.status) &&
    isArtifactFormat(r.format) &&
    (r.path === undefined || typeof r.path === "string") &&
    (r.content === undefined || typeof r.content === "string") &&
    (r.summary === undefined || typeof r.summary === "string") &&
    typeof r.workspaceRoot === "string" &&
    (r.sessionKey === undefined || typeof r.sessionKey === "string") &&
    (r.requirementId === undefined || typeof r.requirementId === "string") &&
    (r.taskId === undefined || typeof r.taskId === "string") &&
    isStringArray(r.linkedMemoryIds) &&
    (r.sourceEventId === undefined || typeof r.sourceEventId === "string") &&
    typeof r.createdAt === "string" &&
    typeof r.updatedAt === "string"
  );
}
