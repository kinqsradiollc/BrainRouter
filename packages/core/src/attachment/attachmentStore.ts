/**
 * ATTACHMENTS (0.4.15 workflow gaps) — durable per-workspace record of files a
 * user attaches to a session: PDFs, images/screenshots, text/code, or generic
 * blobs. The ORIGINAL file is always preserved: it is copied into the workspace
 * state tree under `attachments/<id>/<name>` and the record remembers where it
 * came from. Extracted text/metadata (when practical) rides on the record so the
 * attachment can be used as session context and linked from review/artifact/plan
 * workflows.
 *
 * Persisted WORKSPACE-scoped at
 *   ~/.brainrouter/workspaces/<encoded>/cli/attachments.json
 * with blobs alongside under `cli/attachments/<id>/`. Each record carries its
 * `sessionKey` so the UI can show one session's or the whole workspace's
 * attachments from the same source. Pure functions of (workspaceRoot, …);
 * BrainRouter memory stays the source of truth — the caller captures a note and
 * links the id back via `linkAttachmentMemory`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getStateDir, getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';
import type { AttachmentKind, AttachmentRecord } from '@kinqs/brainrouter-types';

interface AttachmentFile {
  attachments: AttachmentRecord[];
}

const FILE_NAME = 'attachments.json';

function file(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, FILE_NAME);
}

function readFile(workspaceRoot: string): AttachmentFile {
  return readJsonFile<AttachmentFile>(file(workspaceRoot), { attachments: [] });
}

function writeFile(workspaceRoot: string, data: AttachmentFile): void {
  writeJsonFile(file(workspaceRoot), data);
}

/** Absolute directory the blob for an attachment id lives in. */
export function attachmentDir(workspaceRoot: string, id: string): string {
  const dir = path.join(getStateDir(workspaceRoot), 'attachments', id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Sanitize a user file name to a safe single path segment. */
export function safeAttachmentName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  return base.slice(0, 120) || 'file';
}

export interface CreateAttachmentInput {
  id: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  byteSize: number;
  sha256: string;
  storedPath: string;
  sourcePath?: string;
  sessionKey: string;
  requirementId?: string;
  taskId?: string;
  extractedText?: string;
  textTruncated?: boolean;
  width?: number;
  height?: number;
  pageCount?: number;
  sourceEventId?: string;
}

/**
 * Persist an attachment record (the blob is expected to already be written to
 * `storedPath` by the ingest service). Stamps timestamps + empty memory links.
 */
export function createAttachment(workspaceRoot: string, input: CreateAttachmentInput): AttachmentRecord {
  const data = readFile(workspaceRoot);
  const at = new Date().toISOString();
  const record: AttachmentRecord = {
    id: input.id,
    name: input.name,
    kind: input.kind,
    mimeType: input.mimeType,
    byteSize: input.byteSize,
    sha256: input.sha256,
    storedPath: input.storedPath,
    workspaceRoot,
    sessionKey: input.sessionKey,
    linkedMemoryIds: [],
    createdAt: at,
    updatedAt: at,
  };
  if (input.sourcePath) record.sourcePath = input.sourcePath;
  if (input.requirementId) record.requirementId = input.requirementId;
  if (input.taskId) record.taskId = input.taskId;
  if (input.extractedText !== undefined) record.extractedText = input.extractedText;
  if (input.textTruncated !== undefined) record.textTruncated = input.textTruncated;
  if (input.width !== undefined) record.width = input.width;
  if (input.height !== undefined) record.height = input.height;
  if (input.pageCount !== undefined) record.pageCount = input.pageCount;
  if (input.sourceEventId) record.sourceEventId = input.sourceEventId;
  data.attachments.push(record);
  writeFile(workspaceRoot, data);
  return record;
}

export function getAttachment(workspaceRoot: string, id: string): AttachmentRecord | undefined {
  return readFile(workspaceRoot).attachments.find((a) => a.id === id);
}

export interface AttachmentFilter {
  sessionKey?: string;
  kind?: AttachmentKind;
  requirementId?: string;
  taskId?: string;
}

/** Attachments matching the filter, NEWEST-FIRST. */
export function listAttachments(workspaceRoot: string, filter: AttachmentFilter = {}): AttachmentRecord[] {
  const { sessionKey, kind, requirementId, taskId } = filter;
  return readFile(workspaceRoot)
    .attachments.filter((a) => {
      if (sessionKey !== undefined && a.sessionKey !== sessionKey) return false;
      if (kind !== undefined && a.kind !== kind) return false;
      if (requirementId !== undefined && a.requirementId !== requirementId) return false;
      if (taskId !== undefined && a.taskId !== taskId) return false;
      return true;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface AttachmentPatch {
  requirementId?: string;
  taskId?: string;
  extractedText?: string;
  textTruncated?: boolean;
}

export function updateAttachment(
  workspaceRoot: string,
  id: string,
  patch: AttachmentPatch,
): AttachmentRecord | undefined {
  const data = readFile(workspaceRoot);
  const a = data.attachments.find((x) => x.id === id);
  if (!a) return undefined;
  if (patch.requirementId !== undefined) a.requirementId = patch.requirementId;
  if (patch.taskId !== undefined) a.taskId = patch.taskId;
  if (patch.extractedText !== undefined) a.extractedText = patch.extractedText;
  if (patch.textTruncated !== undefined) a.textTruncated = patch.textTruncated;
  a.updatedAt = new Date().toISOString();
  writeFile(workspaceRoot, data);
  return a;
}

/** Link a memory id into an attachment's `linkedMemoryIds` (de-duplicated). */
export function linkAttachmentMemory(
  workspaceRoot: string,
  id: string,
  memoryId: string,
): AttachmentRecord | undefined {
  if (!memoryId) return getAttachment(workspaceRoot, id);
  const data = readFile(workspaceRoot);
  const a = data.attachments.find((x) => x.id === id);
  if (!a) return undefined;
  if (!a.linkedMemoryIds.includes(memoryId)) {
    a.linkedMemoryIds.push(memoryId);
    a.updatedAt = new Date().toISOString();
    writeFile(workspaceRoot, data);
  }
  return a;
}

/** Delete an attachment record + its blob directory. Returns whether it existed. */
export function deleteAttachment(workspaceRoot: string, id: string): boolean {
  const data = readFile(workspaceRoot);
  const idx = data.attachments.findIndex((a) => a.id === id);
  if (idx < 0) return false;
  data.attachments.splice(idx, 1);
  writeFile(workspaceRoot, data);
  try {
    fs.rmSync(path.join(getStateDir(workspaceRoot), 'attachments', id), { recursive: true, force: true });
  } catch { /* best-effort blob cleanup */ }
  return true;
}
