/**
 * Attachment ingestion (0.4.15 workflow gaps) — the one service that turns a
 * file (a path on disk, or raw bytes dropped in the desktop) into a durable
 * {@link AttachmentRecord}: hash it, detect its kind/mime, extract text/metadata
 * where practical (image dimensions, PDF page count + text, text/code body),
 * preserve the ORIGINAL blob in the workspace state tree, persist the record,
 * and emit a telemetry event. Memory capture (which needs an MCP client) stays
 * with the caller — the command/host captures a note and links it back via
 * `linkAttachmentMemory`, matching the requirement/annotation pattern.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { attachmentDir, createAttachment, safeAttachmentName } from './attachmentStore.js';
import { detectKind } from './detect.js';
import { sniffImage } from './imageMeta.js';
import { extractPdf } from './pdfText.js';
import { recordTelemetry } from '../telemetry/telemetry.js';
import { TELEMETRY_EVENTS } from '../telemetry/contracts.js';
import type { AttachmentRecord } from '@kinqs/brainrouter-types';

/** Cap on extracted text persisted per attachment. */
export const MAX_ATTACHMENT_TEXT_CHARS = 20_000;
/** Hard cap on attachment size (50 MB) so a stray huge file can't wedge the host. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export type AttachmentSource =
  | { kind: 'path'; path: string }
  | { kind: 'bytes'; name: string; data: Buffer };

export interface IngestAttachmentInput {
  workspaceRoot: string;
  sessionKey: string;
  requirementId?: string;
  taskId?: string;
  source: AttachmentSource;
}

function resolveBytes(source: AttachmentSource): { name: string; data: Buffer; sourcePath?: string } {
  if (source.kind === 'path') {
    const abs = path.resolve(source.path);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error(`Not a file: ${abs}`);
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`File too large: ${stat.size} bytes (cap ${MAX_ATTACHMENT_BYTES}).`);
    }
    return { name: path.basename(abs), data: fs.readFileSync(abs), sourcePath: abs };
  }
  if (source.data.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File too large: ${source.data.length} bytes (cap ${MAX_ATTACHMENT_BYTES}).`);
  }
  return { name: source.name, data: source.data };
}

/**
 * Ingest a file into a durable attachment record. Throws on IO / size errors
 * (the caller surfaces a clear message + telemetry). On success records an
 * `attachment_ingested` telemetry event.
 */
export async function ingestAttachment(input: IngestAttachmentInput): Promise<AttachmentRecord> {
  const { workspaceRoot, sessionKey } = input;
  let resolved: { name: string; data: Buffer; sourcePath?: string };
  try {
    resolved = resolveBytes(input.source);
  } catch (err) {
    recordTelemetry({
      name: TELEMETRY_EVENTS.attachment_ingested, workspaceRoot, sessionKey, ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const { name, data, sourcePath } = resolved;
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const detected = detectKind({ name, buffer: data });
  let mimeType = detected.mime;
  const kind = detected.kind;

  let extractedText: string | undefined;
  let textTruncated: boolean | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let pageCount: number | undefined;

  if (kind === 'image') {
    const meta = sniffImage(data);
    if (meta) {
      if (meta.width !== undefined) width = meta.width;
      if (meta.height !== undefined) height = meta.height;
      if (meta.mime) mimeType = meta.mime;
    }
  } else if (kind === 'pdf') {
    const ex = extractPdf(data, { maxChars: MAX_ATTACHMENT_TEXT_CHARS });
    pageCount = ex.pageCount;
    if (ex.text) {
      extractedText = ex.text;
      textTruncated = ex.truncated;
    }
  } else if (kind === 'text' || kind === 'code') {
    const text = data.toString('utf8');
    textTruncated = text.length > MAX_ATTACHMENT_TEXT_CHARS;
    extractedText = textTruncated ? text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) : text;
  }

  const id = `att_${randomUUID().slice(0, 8)}`;
  const storedPath = path.join(attachmentDir(workspaceRoot, id), safeAttachmentName(name));
  fs.writeFileSync(storedPath, data);

  const record = createAttachment(workspaceRoot, {
    id,
    name,
    kind,
    mimeType,
    byteSize: data.length,
    sha256,
    storedPath,
    sourcePath,
    sessionKey,
    requirementId: input.requirementId,
    taskId: input.taskId,
    extractedText,
    textTruncated,
    width,
    height,
    pageCount,
  });

  recordTelemetry({
    name: TELEMETRY_EVENTS.attachment_ingested, workspaceRoot, sessionKey, ok: true,
    props: {
      kind,
      mime: mimeType,
      bytes: data.length,
      extractedChars: extractedText?.length ?? 0,
      pages: pageCount ?? 0,
    },
  });

  return record;
}

/**
 * A compact agent-readable summary of an attachment, for injecting into a
 * session as context. Includes the kind, size, key metadata, and (capped)
 * extracted text. Pure.
 */
export function attachmentContextMarkdown(record: AttachmentRecord, opts?: { maxChars?: number }): string {
  const cap = opts?.maxChars ?? 4_000;
  const lines: string[] = [];
  const dims = record.width && record.height ? ` · ${record.width}×${record.height}` : '';
  const pages = record.pageCount ? ` · ${record.pageCount} page(s)` : '';
  lines.push(`### Attachment: ${record.name}`);
  lines.push(`- id: ${record.id} · kind: ${record.kind} · ${record.mimeType} · ${record.byteSize} bytes${dims}${pages}`);
  lines.push(`- stored: ${record.storedPath}`);
  if (record.extractedText) {
    const body = record.extractedText.slice(0, cap);
    lines.push('', '```', body, '```');
    if (record.extractedText.length > cap || record.textTruncated) lines.push('_(text truncated)_');
  } else if (record.kind === 'image') {
    lines.push('_(image — original preserved; no text extracted)_');
  }
  return lines.join('\n');
}
