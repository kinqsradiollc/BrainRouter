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

/** How the artifact's content should be rendered/previewed (§AV-2). `svg` renders
 *  inline, `mermaid` renders a diagram from its source, `code` is a
 *  syntax-highlighted source file (see {@link ArtifactRecord.language}). */
export type ArtifactFormat = "markdown" | "html" | "text" | "svg" | "mermaid" | "code";

/** Who produced an artifact version: the model/agent, or the user editing directly. */
export type ArtifactEditor = "agent" | "user";

/**
 * One immutable snapshot in an artifact's version history (§AV-1). A version is
 * appended whenever the CONTENT-bearing fields change (content / path / format);
 * metadata-only edits (status, summary, links) do NOT create a version. `v` is
 * 1-based; `v:1` is the artifact at creation. Reverting restores a prior
 * version's content as a NEW version (append-only — history is never rewritten).
 */
export interface ArtifactVersion {
  /** 1-based version number; v1 is the initial content. */
  v: number;
  /** Inline content at this version (omitted for a pure file-backed snapshot). */
  content?: string;
  /** Workspace-relative file path at this version, when file-backed. */
  path?: string;
  /** Format at this version (a version may change the format). */
  format: ArtifactFormat;
  /** FNV-1a hash of the (whitespace-normalized) content — cheap change-detection
   *  and the anchor key the §6 annotation staleness check reuses. */
  contentHash: string;
  /** Whether the model or the user produced this version. */
  editedBy: ArtifactEditor;
  /** Optional one-line note about what changed (e.g. "revert to v2"). */
  note?: string;
  /** ISO-8601 timestamp this version was created. */
  editedAt: string;
  /** Agent-protocol / orchestration event id that produced this version, if any. */
  sourceEventId?: string;
}

/** Current artifact record schema version (for migrate-on-read). 1 = the
 *  pre-versioning shape (no `versions`); 2 adds the version history. */
export const ARTIFACT_SCHEMA_VERSION = 2;

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
  /** Source language for `format: 'code'` (e.g. "ts", "py") — drives syntax
   *  highlighting in the viewer (§AV-2). */
  language?: string;
  /** Append-only version history, oldest-first (§AV-1). Absent on legacy
   *  pre-v2 records until the store migrates them on first read. */
  versions?: ArtifactVersion[];
  /** The active version number (the version whose content mirrors `content`/`path`). */
  currentVersion?: number;
  /** Record schema version — {@link ARTIFACT_SCHEMA_VERSION} for current records. */
  schemaVersion?: number;
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

const ARTIFACT_FORMATS: readonly ArtifactFormat[] = ["markdown", "html", "text", "svg", "mermaid", "code"];

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
 * FNV-1a hash of an artifact's content (whitespace-normalized), as an 8-hex
 * string. Cheap, stable, dependency-free — the same fingerprinting style the §6
 * annotation anchor uses, so CLI / desktop / MCP hash content identically.
 */
export function hashArtifactContent(content: string | undefined | null): string {
  const s = (content ?? "").replace(/\s+/g, " ").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Structural type guard for an {@link ArtifactVersion}. */
export function isArtifactVersion(x: unknown): x is ArtifactVersion {
  if (!x || typeof x !== "object") return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.v === "number" &&
    (v.content === undefined || typeof v.content === "string") &&
    (v.path === undefined || typeof v.path === "string") &&
    isArtifactFormat(v.format) &&
    typeof v.contentHash === "string" &&
    (v.editedBy === "agent" || v.editedBy === "user") &&
    (v.note === undefined || typeof v.note === "string") &&
    typeof v.editedAt === "string" &&
    (v.sourceEventId === undefined || typeof v.sourceEventId === "string")
  );
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
    (r.language === undefined || typeof r.language === "string") &&
    (r.versions === undefined || (Array.isArray(r.versions) && r.versions.every(isArtifactVersion))) &&
    (r.currentVersion === undefined || typeof r.currentVersion === "number") &&
    (r.schemaVersion === undefined || typeof r.schemaVersion === "number") &&
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
