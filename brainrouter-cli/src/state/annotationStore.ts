/**
 * ANNOTATION-RECORDS (0.4.15) — durable per-workspace store for Annotation
 * Records: a general-purpose feedback record anchored to a plan, requirement,
 * artifact, markdown/HTML doc, agent message, code diff/file, or review
 * finding. Each carries an optional anchor (file + lines / block / selected
 * text), a comment, an optional suggested replacement, a severity, a lifecycle
 * status, and links back to the session / requirement / task / artifact /
 * memory it relates to.
 *
 * Persisted at `<workspace cli state>/annotations.json`, keyed by annotation
 * id, exactly like requirementStore / sessionMetaStore. The shared record shape
 * lives in `@kinqs/brainrouter-types` (AnnotationRecord) — this module never
 * redefines it, it only reads/writes/merges. All helpers are pure functions of
 * (workspaceRoot, …) so they are trivially testable without a REPL.
 */
import { randomUUID } from 'node:crypto';
import {
  type AnnotationRecord,
  type AnnotationAnchor,
  type AnnotationStatus,
  type AnnotationSeverity,
  type AnnotationTargetKind,
} from '@kinqs/brainrouter-types';
import { getCliStateFile, readJsonFile, writeJsonFile } from './cliState.js';

type AnnotationStore = Record<string, AnnotationRecord>;

function annotationsFile(workspaceRoot: string): string {
  return getCliStateFile(workspaceRoot, 'annotations.json');
}

/** Every annotation persisted for a workspace, keyed by id. */
export function readAnnotationsAll(workspaceRoot: string): AnnotationStore {
  return readJsonFile<AnnotationStore>(annotationsFile(workspaceRoot), {});
}

/** One annotation by id, or `undefined` when it doesn't exist. */
export function getAnnotation(workspaceRoot: string, id: string): AnnotationRecord | undefined {
  return readAnnotationsAll(workspaceRoot)[id];
}

/** Fields a caller may supply at creation time. The store stamps id/timestamps
 *  and defaults everything else so a `{ type, body }` call is enough. */
export interface CreateAnnotationInput {
  type: AnnotationTargetKind;
  body: string;
  targetId?: string;
  sessionKey?: string;
  requirementId?: string;
  taskId?: string;
  artifactId?: string;
  anchor?: AnnotationAnchor;
  suggestedText?: string;
  severity?: AnnotationSeverity;
  status?: AnnotationStatus;
  author?: string;
  linkedMemoryIds?: string[];
  sourceEventId?: string;
}

/**
 * Create an open annotation. Generates an `ann_<8hex>` id (matching the
 * `req_`/`wkr_` short-id convention used by the other CLI stores), stamps
 * createdAt/updatedAt, defaults status to `open`, and persists it. Returns the
 * stored record.
 */
export function createAnnotation(
  workspaceRoot: string,
  input: CreateAnnotationInput,
): AnnotationRecord {
  const body = input.body?.trim();
  if (!body) {
    throw new Error('Annotation body must be a non-empty string.');
  }
  const all = readAnnotationsAll(workspaceRoot);
  const now = new Date().toISOString();
  const id = `ann_${randomUUID().slice(0, 8)}`;
  const record: AnnotationRecord = {
    id,
    type: input.type,
    body,
    workspaceRoot,
    status: input.status ?? 'open',
    linkedMemoryIds: [...(input.linkedMemoryIds ?? [])],
    createdAt: now,
    updatedAt: now,
  };
  // Optional fields are only set when present, so an in-memory record matches
  // its JSON round-trip exactly (no `key: undefined` that disappears on read).
  if (input.targetId) record.targetId = input.targetId;
  if (input.sessionKey) record.sessionKey = input.sessionKey;
  if (input.requirementId) record.requirementId = input.requirementId;
  if (input.taskId) record.taskId = input.taskId;
  if (input.artifactId) record.artifactId = input.artifactId;
  if (input.anchor && hasAnchorContent(input.anchor)) record.anchor = { ...input.anchor };
  const suggested = input.suggestedText?.trim();
  if (suggested) record.suggestedText = suggested;
  if (input.severity) record.severity = input.severity;
  const author = input.author?.trim();
  if (author) record.author = author;
  if (input.sourceEventId) record.sourceEventId = input.sourceEventId;
  all[id] = record;
  writeJsonFile(annotationsFile(workspaceRoot), all);
  return record;
}

/** A merge-able patch for an existing annotation. `id`, `workspaceRoot`,
 *  `createdAt`, and `updatedAt` are owned by the store and cannot be patched. */
export type AnnotationPatch = Partial<
  Omit<AnnotationRecord, 'id' | 'workspaceRoot' | 'createdAt' | 'updatedAt'>
>;

/**
 * Merge a patch into an existing annotation and bump `updatedAt`. Returns the
 * updated record, or `undefined` when no annotation has that id. The store
 * keeps ownership of id/workspaceRoot/createdAt — those are never overwritten.
 */
export function updateAnnotation(
  workspaceRoot: string,
  id: string,
  patch: AnnotationPatch,
): AnnotationRecord | undefined {
  const all = readAnnotationsAll(workspaceRoot);
  const existing = all[id];
  if (!existing) return undefined;
  const next: AnnotationRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    workspaceRoot: existing.workspaceRoot,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  all[id] = next;
  writeJsonFile(annotationsFile(workspaceRoot), all);
  return next;
}

/** Transition an annotation's lifecycle status, bumping `updatedAt`. Returns
 *  the updated record, or `undefined` when the id doesn't exist. */
export function setStatus(
  workspaceRoot: string,
  id: string,
  status: AnnotationStatus,
): AnnotationRecord | undefined {
  return updateAnnotation(workspaceRoot, id, { status });
}

export interface AnnotationFilter {
  /** Match the annotation's target kind (`type`). */
  targetKind?: AnnotationTargetKind;
  /** Match the targeted record id. */
  targetId?: string;
  status?: AnnotationStatus;
  severity?: AnnotationSeverity;
  sessionKey?: string;
  requirementId?: string;
  /** Match the anchor's `filePath`. */
  file?: string;
}

/**
 * List a workspace's annotations newest-first, optionally narrowed by any
 * combination of target kind / target id / status / severity / sessionKey /
 * requirementId / anchored file. All supplied filters are ANDed.
 */
export function listAnnotations(
  workspaceRoot: string,
  filter?: AnnotationFilter,
): AnnotationRecord[] {
  const all = Object.values(readAnnotationsAll(workspaceRoot));
  const filtered = all.filter((a) => {
    if (filter?.targetKind && a.type !== filter.targetKind) return false;
    if (filter?.targetId && a.targetId !== filter.targetId) return false;
    if (filter?.status && a.status !== filter.status) return false;
    if (filter?.severity && a.severity !== filter.severity) return false;
    if (filter?.sessionKey && a.sessionKey !== filter.sessionKey) return false;
    if (filter?.requirementId && a.requirementId !== filter.requirementId) return false;
    if (filter?.file && a.anchor?.filePath !== filter.file) return false;
    return true;
  });
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Link targets for {@link linkAnnotation}. Currently a memory record id. */
export interface AnnotationLink {
  memoryId?: string;
}

/**
 * Push a memory id into the annotation's `linkedMemoryIds`, de-duplicating so
 * the same id is never stored twice. No-op (but still bumps updatedAt) when the
 * supplied id is already present. Returns the updated record, or `undefined`
 * when the id doesn't exist.
 */
export function linkAnnotation(
  workspaceRoot: string,
  id: string,
  link: AnnotationLink,
): AnnotationRecord | undefined {
  const existing = getAnnotation(workspaceRoot, id);
  if (!existing) return undefined;
  const linkedMemoryIds = pushUnique(existing.linkedMemoryIds, link.memoryId);
  return updateAnnotation(workspaceRoot, id, { linkedMemoryIds });
}

/** Delete an annotation. Returns `true` if one was removed, `false` otherwise. */
export function deleteAnnotation(workspaceRoot: string, id: string): boolean {
  const all = readAnnotationsAll(workspaceRoot);
  if (!all[id]) return false;
  delete all[id];
  writeJsonFile(annotationsFile(workspaceRoot), all);
  return true;
}

/** True when an anchor carries at least one meaningful field — used to drop an
 *  all-empty anchor object so a global comment stays anchor-less on disk. */
function hasAnchorContent(anchor: AnnotationAnchor): boolean {
  return (
    anchor.filePath !== undefined ||
    anchor.startLine !== undefined ||
    anchor.endLine !== undefined ||
    (anchor.block !== undefined && anchor.block !== '') ||
    (anchor.selectedText !== undefined && anchor.selectedText !== '')
  );
}

/** Return a copy of `list` with `value` appended iff it's a non-empty string
 *  not already present. Pure — never mutates the input array. */
function pushUnique(list: string[], value: string | undefined): string[] {
  if (!value) return list;
  if (list.includes(value)) return list;
  return [...list, value];
}
