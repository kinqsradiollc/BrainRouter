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
  type ArtifactRecord,
  type ArtifactKind,
  type ArtifactStatus,
  type ArtifactFormat,
} from '@kinqs/brainrouter-types';
import { getCliStateFile, readJsonFile, writeJsonFile } from './cliState.js';

type ArtifactStore = Record<string, ArtifactRecord>;

function artifactsFile(workspaceRoot: string): string {
  return getCliStateFile(workspaceRoot, 'artifacts.json');
}

/** Every artifact persisted for a workspace, keyed by id. */
export function readArtifactsAll(workspaceRoot: string): ArtifactStore {
  return readJsonFile<ArtifactStore>(artifactsFile(workspaceRoot), {});
}

/** One artifact by id, or `undefined` when it doesn't exist. */
export function getArtifact(workspaceRoot: string, id: string): ArtifactRecord | undefined {
  return readArtifactsAll(workspaceRoot)[id];
}

/** Fields a caller may supply at creation time. The store stamps id/timestamps
 *  and defaults status, so a `{ kind, title }` call is enough. */
export interface CreateArtifactInput {
  kind: ArtifactKind;
  title: string;
  status?: ArtifactStatus;
  format?: ArtifactFormat;
  path?: string;
  content?: string;
  summary?: string;
  sessionKey?: string;
  requirementId?: string;
  taskId?: string;
  linkedMemoryIds?: string[];
  sourceEventId?: string;
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
  const summary = input.summary?.trim();
  if (summary) record.summary = summary;
  if (input.sessionKey) record.sessionKey = input.sessionKey;
  if (input.requirementId) record.requirementId = input.requirementId;
  if (input.taskId) record.taskId = input.taskId;
  if (input.sourceEventId) record.sourceEventId = input.sourceEventId;
  all[id] = record;
  writeJsonFile(artifactsFile(workspaceRoot), all);
  return record;
}

/** A merge-able patch. `id`, `workspaceRoot`, `createdAt`, `updatedAt` are
 *  owned by the store and cannot be patched. */
export type ArtifactPatch = Partial<
  Omit<ArtifactRecord, 'id' | 'workspaceRoot' | 'createdAt' | 'updatedAt'>
>;

/**
 * Merge a patch into an existing artifact and bump `updatedAt`. Returns the
 * updated record, or `undefined` when no artifact has that id. The store keeps
 * ownership of id/workspaceRoot/createdAt.
 */
export function updateArtifact(
  workspaceRoot: string,
  id: string,
  patch: ArtifactPatch,
): ArtifactRecord | undefined {
  const all = readArtifactsAll(workspaceRoot);
  const existing = all[id];
  if (!existing) return undefined;
  const next: ArtifactRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    workspaceRoot: existing.workspaceRoot,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  all[id] = next;
  writeJsonFile(artifactsFile(workspaceRoot), all);
  return next;
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
  const all = Object.values(readArtifactsAll(workspaceRoot));
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
