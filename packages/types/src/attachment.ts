/**
 * BrainRouter Attachment Records (0.4.15)
 *
 * A durable, linkable record for a file a user attaches to a session: a PDF,
 * an image/screenshot, a text/code file, or a generic blob. The original file
 * is always preserved (copied into the workspace state tree under `storedPath`,
 * with `sourcePath` remembering where it came from); extracted text/metadata is
 * captured where practical so the attachment can be used as session context and
 * linked from review / artifact / plan workflows.
 *
 * Scoped by `workspaceRoot` + `sessionKey`, with optional `requirementId` /
 * `taskId` anchors and memory provenance, matching the rest of this package.
 * Stable, dependency-free contract shared by the CLI store, the desktop host,
 * and (later) MCP tools. camelCase keys, plain-`string` ids, ISO-8601
 * timestamps.
 */

/** Identifier for an attachment. Plain `string` alias (package convention). */
export type AttachmentId = string;

/**
 * Coarse class of the attachment, derived from MIME/extension. Drives preview
 * + extraction strategy. `file` is the generic escape hatch.
 */
export type AttachmentKind = "pdf" | "image" | "text" | "code" | "file";

export interface AttachmentRecord {
  id: AttachmentId;
  /** Original (user-facing) file name. */
  name: string;
  kind: AttachmentKind;
  /** MIME type, sniffed from content or mapped from the extension. */
  mimeType: string;
  /** Size of the stored blob in bytes. */
  byteSize: number;
  /** SHA-256 of the blob (hex) for dedupe + integrity. */
  sha256: string;
  /** Workspace-state-relative path to the preserved original blob. */
  storedPath: string;
  /** Absolute path the file was ingested from, when known. */
  sourcePath?: string;
  /** Absolute workspace root the attachment belongs to. */
  workspaceRoot: string;
  /** Session the attachment was added to. */
  sessionKey: string;
  /** Requirement this attachment supports, when linked. */
  requirementId?: string;
  /** Background task that produced/processed this attachment, when linked. */
  taskId?: string;
  /** Extracted plain text (PDF/text/code), when extraction succeeded. */
  extractedText?: string;
  /** Whether the extracted text was truncated to a cap. */
  textTruncated?: boolean;
  /** Image pixel width, when known. */
  width?: number;
  /** Image pixel height, when known. */
  height?: number;
  /** PDF page count, when known. */
  pageCount?: number;
  /** Cognitive memory record ids captured for this attachment (provenance). */
  linkedMemoryIds: string[];
  /** Agent-protocol / orchestration event id this record originated from. */
  sourceEventId?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp; bumped on every mutation. */
  updatedAt: string;
}

const ATTACHMENT_KINDS: readonly AttachmentKind[] = ["pdf", "image", "text", "code", "file"];

/** Narrow an unknown value to an {@link AttachmentKind}. */
export function isAttachmentKind(x: unknown): x is AttachmentKind {
  return typeof x === "string" && (ATTACHMENT_KINDS as readonly string[]).includes(x);
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

/**
 * Structural type guard for an {@link AttachmentRecord}. Validates required
 * fields + enum membership so a hand-edited or foreign JSON blob is rejected
 * before it is treated as a record.
 */
export function isAttachmentRecord(x: unknown): x is AttachmentRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    isAttachmentKind(r.kind) &&
    typeof r.mimeType === "string" &&
    typeof r.byteSize === "number" &&
    typeof r.sha256 === "string" &&
    typeof r.storedPath === "string" &&
    (r.sourcePath === undefined || typeof r.sourcePath === "string") &&
    typeof r.workspaceRoot === "string" &&
    typeof r.sessionKey === "string" &&
    (r.requirementId === undefined || typeof r.requirementId === "string") &&
    (r.taskId === undefined || typeof r.taskId === "string") &&
    (r.extractedText === undefined || typeof r.extractedText === "string") &&
    (r.width === undefined || typeof r.width === "number") &&
    (r.height === undefined || typeof r.height === "number") &&
    (r.pageCount === undefined || typeof r.pageCount === "number") &&
    isStringArray(r.linkedMemoryIds) &&
    typeof r.createdAt === "string" &&
    typeof r.updatedAt === "string"
  );
}
