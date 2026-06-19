/**
 * ARTIFACT-RECORDS (0.4.15) — durable per-workspace store for Artifact Records:
 * a workflow output a chat produces or reviews (design note, sketch, HTML
 * prototype, markdown report, verification summary, review export), with links
 * back to the requirement / task / session / memory it relates to.
 *
 * Persisted at `<workspace cli state>/artifacts.json`, keyed by artifact id,
 * exactly like requirementStore / annotationStore. The shared record shape
 * lives in `@kinqs/brainrouter-types` (ArtifactRecord) — this module never
 * redefines it, only reads/writes/merges. Distinct from workflowArtifacts
 * (raw workflow-run output files). All helpers are pure functions of
 * (workspaceRoot, …) so they are trivially testable without a REPL.
 */
import { randomUUID } from 'node:crypto';
import {
  ARTIFACT_SCHEMA_VERSION,
  hashArtifactContent,
  type ArtifactRecord,
  type ArtifactKind,
  type ArtifactStatus,
  type ArtifactFormat,
  type ArtifactVersion,
  type ArtifactEditor,
} from '@kinqs/brainrouter-types';
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';

type ArtifactStore = Record<string, ArtifactRecord>;

function artifactsFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'artifacts.json');
}

/** Build a version snapshot from a record's current content-bearing fields. */
function snapshot(rec: Pick<ArtifactRecord, 'content' | 'path' | 'format' | 'sourceEventId'>, v: number, editedBy: ArtifactEditor, editedAt: string, note?: string, sourceEventId?: string): ArtifactVersion {
  const ver: ArtifactVersion = { v, format: rec.format, contentHash: hashArtifactContent(rec.content), editedBy, editedAt };
  if (rec.content !== undefined) ver.content = rec.content;
  if (rec.path !== undefined) ver.path = rec.path;
  if (note) ver.note = note;
  const src = sourceEventId ?? rec.sourceEventId;
  if (src) ver.sourceEventId = src;
  return ver;
}

/**
 * Ensure a record carries version history. Idempotent: a v2+ record is returned
 * as-is; a legacy pre-versioning record gets a synthesized `v1` from its current
 * content/path/format. Migration is IN-MEMORY only (a read never writes); the
 * migrated form is persisted on the next mutation.
 */
function ensureVersioned(rec: ArtifactRecord): ArtifactRecord {
  if (rec.versions && rec.versions.length && typeof rec.currentVersion === 'number') return rec;
  const v1 = snapshot(rec, 1, 'agent', rec.updatedAt || rec.createdAt);
  return { ...rec, versions: [v1], currentVersion: 1, schemaVersion: ARTIFACT_SCHEMA_VERSION };
}

/** Version-authoring metadata threaded through mutations (§AV-1). */
export interface ArtifactVersionOpts {
  /** Who is making this edit — defaults to 'agent'. */
  editedBy?: ArtifactEditor;
  /** One-line note for the version (e.g. why it changed). */
  note?: string;
  /** Agent-protocol event id that produced this version. */
  sourceEventId?: string;
}

/** Every artifact persisted for a workspace, keyed by id (raw, as on disk). */
export function readArtifactsAll(workspaceRoot: string): ArtifactStore {
  return readJsonFile<ArtifactStore>(artifactsFile(workspaceRoot), {});
}

/** One artifact by id (version-migrated in memory), or `undefined`. */
export function getArtifact(workspaceRoot: string, id: string): ArtifactRecord | undefined {
  const rec = readArtifactsAll(workspaceRoot)[id];
  return rec ? ensureVersioned(rec) : undefined;
}

/** Fields a caller may supply at creation time. The store stamps id/timestamps
 *  and defaults status, so a `{ kind, title }` call is enough. */
export interface CreateArtifactInput {
  kind: ArtifactKind;
  title: string;
  status?: ArtifactStatus;
  format?: ArtifactFormat;
  language?: string;
  path?: string;
  content?: string;
  summary?: string;
  sessionKey?: string;
  requirementId?: string;
  taskId?: string;
  linkedMemoryIds?: string[];
  sourceEventId?: string;
  /** Who authored the initial version — defaults to 'agent'. */
  editedBy?: ArtifactEditor;
}

/**
 * Create an artifact. Generates an `art_<8hex>` id (matching the short-id
 * convention of the other CLI stores), stamps createdAt/updatedAt, defaults
 * status `draft` + format `markdown`, and persists it. Returns the stored record.
 */
export function createArtifact(
  workspaceRoot: string,
  input: CreateArtifactInput,
): ArtifactRecord {
  const title = input.title?.trim();
  if (!title) {
    throw new Error('Artifact title must be a non-empty string.');
  }
  const all = readArtifactsAll(workspaceRoot);
  const now = new Date().toISOString();
  const id = `art_${randomUUID().slice(0, 8)}`;
  const record: ArtifactRecord = {
    id,
    kind: input.kind,
    title,
    status: input.status ?? 'draft',
    format: input.format ?? 'markdown',
    workspaceRoot,
    linkedMemoryIds: [...(input.linkedMemoryIds ?? [])],
    createdAt: now,
    updatedAt: now,
  };
  // Optional fields only set when present, so an in-memory record matches its
  // JSON round-trip exactly (no `key: undefined` that disappears on read).
  const path = input.path?.trim();
  if (path) record.path = path;
  if (typeof input.content === 'string' && input.content.length) record.content = input.content;
  if (input.language?.trim()) record.language = input.language.trim();
  const summary = input.summary?.trim();
  if (summary) record.summary = summary;
  if (input.sessionKey) record.sessionKey = input.sessionKey;
  if (input.requirementId) record.requirementId = input.requirementId;
  if (input.taskId) record.taskId = input.taskId;
  if (input.sourceEventId) record.sourceEventId = input.sourceEventId;
  // §AV-1 — every artifact starts at v1 so the timeline is anchored from birth.
  record.versions = [snapshot(record, 1, input.editedBy ?? 'agent', now, undefined, input.sourceEventId)];
  record.currentVersion = 1;
  record.schemaVersion = ARTIFACT_SCHEMA_VERSION;
  all[id] = record;
  writeJsonFile(artifactsFile(workspaceRoot), all);
  return record;
}

/** A merge-able patch. `id`, `workspaceRoot`, `createdAt`, `updatedAt`, and the
 *  version fields are owned by the store and cannot be patched directly. */
export type ArtifactPatch = Partial<
  Omit<ArtifactRecord, 'id' | 'workspaceRoot' | 'createdAt' | 'updatedAt' | 'versions' | 'currentVersion' | 'schemaVersion'>
>;

/**
 * Merge a patch into an existing artifact and bump `updatedAt`. When the patch
 * changes a CONTENT-bearing field (content / path / format), a new version is
 * appended (§AV-1); metadata-only edits (status / summary / links) do NOT create
 * a version. Returns the updated record, or `undefined` when no artifact has
 * that id. The store keeps ownership of id/workspaceRoot/createdAt + history.
 */
export function updateArtifact(
  workspaceRoot: string,
  id: string,
  patch: ArtifactPatch,
  opts?: ArtifactVersionOpts,
): ArtifactRecord | undefined {
  const all = readArtifactsAll(workspaceRoot);
  const raw = all[id];
  if (!raw) return undefined;
  const existing = ensureVersioned(raw);
  const now = new Date().toISOString();
  const next: ArtifactRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    workspaceRoot: existing.workspaceRoot,
    createdAt: existing.createdAt,
    updatedAt: now,
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
  };
  // Keep in-memory == JSON round-trip: an explicitly-cleared optional drops out.
  if (next.content === undefined) delete next.content;
  if (next.path === undefined) delete next.path;

  const contentChanged =
    ('content' in patch && patch.content !== existing.content) ||
    ('path' in patch && patch.path !== existing.path) ||
    ('format' in patch && patch.format !== existing.format);
  if (contentChanged) {
    const versions = [...(existing.versions ?? [])];
    const v = (versions[versions.length - 1]?.v ?? 0) + 1;
    versions.push(snapshot(next, v, opts?.editedBy ?? 'agent', now, opts?.note, opts?.sourceEventId));
    next.versions = versions;
    next.currentVersion = v;
  }

  all[id] = next;
  writeJsonFile(artifactsFile(workspaceRoot), all);
  return next;
}

/** The version history of an artifact, oldest-first; `[]` for a missing id. */
export function listArtifactVersions(workspaceRoot: string, id: string): ArtifactVersion[] {
  const rec = getArtifact(workspaceRoot, id);
  return rec?.versions ? [...rec.versions] : [];
}

/** One version snapshot by number, or `undefined`. */
export function getArtifactVersion(workspaceRoot: string, id: string, v: number): ArtifactVersion | undefined {
  return getArtifact(workspaceRoot, id)?.versions?.find((x) => x.v === v);
}

/**
 * Restore a prior version's content/path/format as a NEW version (append-only —
 * history is never rewritten, mirroring "restore" in Claude Artifacts). Returns
 * the updated record, or `undefined` when the id or target version is unknown.
 * Reverting to the already-current content is a no-op (no new version).
 */
export function revertArtifact(
  workspaceRoot: string,
  id: string,
  targetVersion: number,
  opts?: ArtifactVersionOpts,
): ArtifactRecord | undefined {
  const existing = getArtifact(workspaceRoot, id);
  if (!existing) return undefined;
  const target = existing.versions?.find((x) => x.v === targetVersion);
  if (!target) return undefined;
  return updateArtifact(
    workspaceRoot,
    id,
    { content: target.content, path: target.path, format: target.format },
    { editedBy: opts?.editedBy ?? 'user', note: opts?.note ?? `revert to v${targetVersion}`, sourceEventId: opts?.sourceEventId },
  );
}

export interface ArtifactFilter {
  kind?: ArtifactKind;
  status?: ArtifactStatus;
  sessionKey?: string;
  requirementId?: string;
}

/**
 * List a workspace's artifacts newest-first, optionally narrowed by
 * kind/status/sessionKey/requirementId. All supplied filters are ANDed.
 */
export function listArtifacts(
  workspaceRoot: string,
  filter?: ArtifactFilter,
): ArtifactRecord[] {
  const all = Object.values(readArtifactsAll(workspaceRoot)).map(ensureVersioned);
  const filtered = all.filter((a) => {
    if (filter?.kind && a.kind !== filter.kind) return false;
    if (filter?.status && a.status !== filter.status) return false;
    if (filter?.sessionKey && a.sessionKey !== filter.sessionKey) return false;
    if (filter?.requirementId && a.requirementId !== filter.requirementId) return false;
    return true;
  });
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Push a memory id into the artifact's `linkedMemoryIds`, de-duplicating.
 * Returns the updated record, or `undefined` when the id doesn't exist.
 */
export function linkArtifact(
  workspaceRoot: string,
  id: string,
  link: { memoryId?: string },
): ArtifactRecord | undefined {
  const existing = getArtifact(workspaceRoot, id);
  if (!existing) return undefined;
  if (!link.memoryId || existing.linkedMemoryIds.includes(link.memoryId)) {
    return updateArtifact(workspaceRoot, id, {});
  }
  return updateArtifact(workspaceRoot, id, { linkedMemoryIds: [...existing.linkedMemoryIds, link.memoryId] });
}

/** Delete an artifact. Returns true when a record was removed. */
export function deleteArtifact(workspaceRoot: string, id: string): boolean {
  const all = readArtifactsAll(workspaceRoot);
  if (!all[id]) return false;
  delete all[id];
  writeJsonFile(artifactsFile(workspaceRoot), all);
  return true;
}
