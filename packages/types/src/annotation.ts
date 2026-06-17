/**
 * BrainRouter Annotation Records (0.4.15)
 *
 * An Annotation is a durable, general-purpose feedback record that can be
 * anchored to almost anything a session works with: a plan, a requirement, a
 * markdown/HTML artifact, a code diff or file, an agent message, or a review
 * finding. Each carries an optional anchor (file + line range / block /
 * selected text), a free-text comment, an optional suggested replacement, a
 * severity, a lifecycle status, and links back to the session / requirement /
 * task / artifact / memory it relates to.
 *
 * This module is the stable, dependency-free contract shared by the CLI store
 * (and, in later slices, the desktop panel + MCP tools). Field casing follows
 * the rest of this package — camelCase keys, plain-`string` ids, ISO-8601
 * timestamp strings.
 */

/**
 * Identifier for an annotation. A plain `string` alias (matching the
 * `id: string` convention every other record in this package uses) rather
 * than a nominal brand, so callers can pass ids around without casting.
 */
export type AnnotationId = string;

/**
 * What an annotation is anchored to. Deliberately broad so one record type
 * serves every surface: workflow `plan`s, `requirement` records, generic
 * workflow `artifact`s, `markdown`/`html` documents, agent `message`s, code
 * `diff`s, individual `file`s, and existing `review-finding`s (which an
 * annotation references by id — it never duplicates a finding's payload).
 */
export type AnnotationTargetKind =
  | "plan"
  | "requirement"
  | "artifact"
  | "markdown"
  | "html"
  | "message"
  | "diff"
  | "file"
  | "review-finding";

/**
 * Lifecycle of an annotation. `open` is the freshly-created state; from there
 * it can be `accepted` (the feedback will be applied), `rejected` (declined),
 * `resolved` (addressed), or `ignored` (intentionally set aside).
 */
export type AnnotationStatus = "open" | "accepted" | "rejected" | "resolved" | "ignored";

/** Optional weight a reader can sort/filter by. `info` is the gentlest. */
export type AnnotationSeverity = "info" | "low" | "medium" | "high";

/**
 * Where, within its target, an annotation points. Every field is optional so a
 * global comment on a whole document needs none, a line comment sets
 * file/start/end, and a prose comment can quote the `selectedText` it refers
 * to. `block` names a logical region (e.g. a markdown heading or a function)
 * when line numbers aren't meaningful.
 */
export interface AnnotationAnchor {
  /** Absolute or workspace-relative path the anchor lives in, when file-scoped. */
  filePath?: string;
  /** 1-based first line of the anchored range. */
  startLine?: number;
  /** 1-based last line of the anchored range (defaults to `startLine`). */
  endLine?: number;
  /** A named logical block (heading id, function name, section) when lines don't apply. */
  block?: string;
  /** The exact text the annotation refers to, quoted for stable re-anchoring. */
  selectedText?: string;
  /**
   * §6 STALE DETECTION — a stable fingerprint of the anchored content captured
   * when the annotation was created (the hash of `selectedText`, computed with
   * {@link hashAnchorText}). When the file later changes, the host re-hashes the
   * current lines and compares: a mismatch means the code moved out from under
   * the anchor (see {@link isAnchorStale}). Absent for anchors with no quoted text.
   */
  contentHash?: string;
}

/**
 * §6 COMMENT THREADS — one reply in an annotation's discussion thread. The
 * annotation body is the opening comment; each {@link AnnotationComment} is a
 * follow-up (a reviewer asking, the author answering, an agent reporting a fix).
 */
export interface AnnotationComment {
  /** `cmt_<8hex>` id, unique within the annotation. */
  id: string;
  /** The comment text. */
  body: string;
  /** Who wrote it (free-text actor label), when known. */
  author?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

export interface AnnotationRecord {
  id: AnnotationId;
  /** What kind of thing this annotation targets. */
  type: AnnotationTargetKind;
  /** Id of the targeted plan/requirement/artifact/finding/message, when known. */
  targetId?: string;
  /** Absolute workspace root the annotation belongs to. */
  workspaceRoot: string;
  /** Session this annotation is anchored to, when known. */
  sessionKey?: string;
  /** Requirement record this annotation relates to, if any. */
  requirementId?: string;
  /** Plan/task id this annotation relates to, if any. */
  taskId?: string;
  /** Workflow-artifact id this annotation relates to, if any. */
  artifactId?: string;
  /** Where within the target the annotation points. */
  anchor?: AnnotationAnchor;
  /** The feedback comment itself. */
  body: string;
  /** A suggested replacement / code the author proposes in place of the anchored text. */
  suggestedText?: string;
  /** §6 — the discussion thread on this annotation (follow-ups after the body). */
  comments?: AnnotationComment[];
  /** Optional severity weight for sorting/filtering. */
  severity?: AnnotationSeverity;
  /** Lifecycle status; defaults to `open` at creation. */
  status: AnnotationStatus;
  /** Who left the annotation (free-text actor label), when known. */
  author?: string;
  /** Cognitive memory record ids captured for this annotation. */
  linkedMemoryIds: string[];
  /** Agent-protocol / orchestration event id this record originated from, if any. */
  sourceEventId?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp; bumped on every mutation. */
  updatedAt: string;
}

const ANNOTATION_TARGET_KINDS: readonly AnnotationTargetKind[] = [
  "plan",
  "requirement",
  "artifact",
  "markdown",
  "html",
  "message",
  "diff",
  "file",
  "review-finding",
];

const ANNOTATION_STATUSES: readonly AnnotationStatus[] = [
  "open",
  "accepted",
  "rejected",
  "resolved",
  "ignored",
];

const ANNOTATION_SEVERITIES: readonly AnnotationSeverity[] = ["info", "low", "medium", "high"];

/** Narrow an unknown value to an {@link AnnotationTargetKind}. */
export function isAnnotationTargetKind(x: unknown): x is AnnotationTargetKind {
  return typeof x === "string" && (ANNOTATION_TARGET_KINDS as readonly string[]).includes(x);
}

/** Narrow an unknown value to an {@link AnnotationStatus}. */
export function isAnnotationStatus(x: unknown): x is AnnotationStatus {
  return typeof x === "string" && (ANNOTATION_STATUSES as readonly string[]).includes(x);
}

/** Narrow an unknown value to an {@link AnnotationSeverity}. */
export function isAnnotationSeverity(x: unknown): x is AnnotationSeverity {
  return typeof x === "string" && (ANNOTATION_SEVERITIES as readonly string[]).includes(x);
}

/**
 * §6 — a stable, dependency-free fingerprint of anchored text (FNV-1a, 32-bit,
 * hex). Whitespace is normalized (runs collapsed, ends trimmed) so cosmetic
 * reflowing of the same code doesn't read as a change while a real edit does.
 * Returns `""` for empty/whitespace-only input. Kept here (not in the store) so
 * the CLI, host, and any future MCP tool all fingerprint identically.
 */
export function hashAnchorText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (avoids BigInt / float precision loss).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * §6 STALE DETECTION — true when an anchor has a recorded `contentHash` but the
 * current text at its location no longer matches it (the code moved/changed).
 * An anchor with no `contentHash`, or whose hash still matches, is NOT stale.
 * `currentText` is what the host reads from the anchor's line range today.
 */
export function isAnchorStale(anchor: AnnotationAnchor | undefined, currentText: string): boolean {
  if (!anchor || !anchor.contentHash) return false;
  return hashAnchorText(currentText) !== anchor.contentHash;
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

function isOptionalString(x: unknown): boolean {
  return x === undefined || typeof x === "string";
}

function isOptionalNumber(x: unknown): boolean {
  return x === undefined || typeof x === "number";
}

/** Structural guard for an {@link AnnotationAnchor}: present-and-typed or absent. */
export function isAnnotationAnchor(x: unknown): x is AnnotationAnchor {
  if (x === undefined) return true;
  if (!x || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  return (
    isOptionalString(a.filePath) &&
    isOptionalNumber(a.startLine) &&
    isOptionalNumber(a.endLine) &&
    isOptionalString(a.block) &&
    isOptionalString(a.selectedText) &&
    isOptionalString(a.contentHash)
  );
}

/** Structural guard for one {@link AnnotationComment}. */
export function isAnnotationComment(x: unknown): x is AnnotationComment {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.body === "string" &&
    isOptionalString(c.author) &&
    typeof c.createdAt === "string"
  );
}

/** Guard for an optional comment-thread array (absent or all-valid comments). */
function isOptionalCommentArray(x: unknown): boolean {
  return x === undefined || (Array.isArray(x) && x.every(isAnnotationComment));
}

/**
 * Structural type guard for an {@link AnnotationRecord}. Validates the
 * required fields + enum membership + nested anchor so a hand-edited or
 * foreign JSON blob can be rejected before it is treated as a record.
 */
export function isAnnotationRecord(x: unknown): x is AnnotationRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    isAnnotationTargetKind(r.type) &&
    isOptionalString(r.targetId) &&
    typeof r.workspaceRoot === "string" &&
    isOptionalString(r.sessionKey) &&
    isOptionalString(r.requirementId) &&
    isOptionalString(r.taskId) &&
    isOptionalString(r.artifactId) &&
    isAnnotationAnchor(r.anchor) &&
    typeof r.body === "string" &&
    isOptionalString(r.suggestedText) &&
    isOptionalCommentArray(r.comments) &&
    (r.severity === undefined || isAnnotationSeverity(r.severity)) &&
    isAnnotationStatus(r.status) &&
    isOptionalString(r.author) &&
    isStringArray(r.linkedMemoryIds) &&
    isOptionalString(r.sourceEventId) &&
    typeof r.createdAt === "string" &&
    typeof r.updatedAt === "string"
  );
}
