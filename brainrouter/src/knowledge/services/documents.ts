import { createHash, randomUUID } from "node:crypto";
import { documentText, parsePdfDocument } from "@kinqs/brainrouter-core/attachment";
import { documentParseGate } from "./documentParseGate.js";
import { redactSensitiveMemoryText } from "../../memory/util/redaction.js";
import { canUseKnowledge } from "../contracts/actor.js";
import type { KnowledgeActor } from "../contracts/actor.js";
import {
  KNOWLEDGE_DOCUMENT_ORIGINS,
  KNOWLEDGE_DOCUMENT_STATUSES,
  KNOWLEDGE_PARSE_VERSION,
  KNOWLEDGE_INLINE_SOURCE_FORMATS,
  MAX_KNOWLEDGE_DOCX_BASE64_CHARS,
  MAX_KNOWLEDGE_DOCX_BYTES,
  MAX_KNOWLEDGE_HTML_BYTES,
  MAX_KNOWLEDGE_PDF_BASE64_CHARS,
  MAX_KNOWLEDGE_PDF_BYTES,
  MAX_KNOWLEDGE_TEXT_BYTES,
} from "../contracts/document.js";
import type {
  IngestKnowledgeDocxInput,
  IngestKnowledgePdfInput,
  IngestKnowledgeTextInput,
  KnowledgeDocumentListFilters,
  KnowledgeDocumentListItemView,
  KnowledgeDocumentEnqueueResult,
  KnowledgeDocumentRecord,
  KnowledgeDocumentRetryView,
  KnowledgeDocumentServiceFailure,
  KnowledgeDocumentServiceResult,
  KnowledgeDocumentStatusView,
  KnowledgeInlineSourceFormat,
  KnowledgeSourceFormat,
  ListKnowledgeDocumentsInput,
} from "../contracts/document.js";
import type { KnowledgeDocumentStore } from "../store.js";
import { extractKnowledgeDocxText } from "./docx-parser.js";
import { extractKnowledgeHtmlText } from "./html-parser.js";
import { resolveKnowledgeProject } from "./project-access.js";

const NOT_FOUND: KnowledgeDocumentServiceFailure = { ok: false, code: "not_found" };
const FORBIDDEN: KnowledgeDocumentServiceFailure = { ok: false, code: "forbidden" };
const PDF_HEADER_SCAN_BYTES = 1024;
const MAX_PDF_EXTRACTED_CHARS = Math.floor(MAX_KNOWLEDGE_TEXT_BYTES / 2);
const MAX_SCOPE_ID_LENGTH = 512;

export interface KnowledgeDocumentServiceOptions {
  documentIdGenerator?: () => string;
  jobIdGenerator?: () => string;
  now?: () => string;
}

export class KnowledgeDocumentService {
  readonly #documentIdGenerator: () => string;
  readonly #jobIdGenerator: () => string;
  readonly #now: () => string;

  constructor(
    private readonly store: KnowledgeDocumentStore,
    options: KnowledgeDocumentServiceOptions = {},
  ) {
    this.#documentIdGenerator = options.documentIdGenerator ?? (() => `kdoc_${randomUUID()}`);
    this.#jobIdGenerator = options.jobIdGenerator ?? (() => `kjob_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async ingestText(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    input: IngestKnowledgeTextInput,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentEnqueueResult>> {
    const project = await resolveKnowledgeProject(actor, projectId, this.store);
    if (!project) return NOT_FOUND;
    if (!canUseKnowledge(actor, "write")) return FORBIDDEN;

    const normalizedBaseId = baseId.trim();
    if (!normalizedBaseId) return NOT_FOUND;
    const base = await this.store.getKnowledgeBase(normalizedBaseId, actor.orgId, project.projectId);
    if (!base) return NOT_FOUND;

    const normalized = normalizeTextInput(input);
    if (!normalized.ok) return normalized;
    return this.#enqueueNormalized(actor, project.projectId, base.baseId, normalized.value);
  }

  async ingestPdf(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    input: IngestKnowledgePdfInput,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentEnqueueResult>> {
    const project = await resolveKnowledgeProject(actor, projectId, this.store);
    if (!project) return NOT_FOUND;
    if (!canUseKnowledge(actor, "write")) return FORBIDDEN;

    const normalizedBaseId = baseId.trim();
    if (!normalizedBaseId) return NOT_FOUND;
    const base = await this.store.getKnowledgeBase(normalizedBaseId, actor.orgId, project.projectId);
    if (!base) return NOT_FOUND;

    // ADR-030 Q3 — the tenant the parse is charged to. A personal account is its
    // own tenant, so one person cannot fill the queue on everyone else's behalf
    // either.
    const normalized = await normalizePdfInput(input, actor.orgId ?? `user:${actor.userId}`);
    if (!normalized.ok) return normalized;
    return this.#enqueueNormalized(actor, project.projectId, base.baseId, normalized.value);
  }

  async ingestDocx(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    input: IngestKnowledgeDocxInput,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentEnqueueResult>> {
    const project = await resolveKnowledgeProject(actor, projectId, this.store);
    if (!project) return NOT_FOUND;
    if (!canUseKnowledge(actor, "write")) return FORBIDDEN;

    const normalizedBaseId = baseId.trim();
    if (!normalizedBaseId) return NOT_FOUND;
    const base = await this.store.getKnowledgeBase(normalizedBaseId, actor.orgId, project.projectId);
    if (!base) return NOT_FOUND;

    const normalized = normalizeDocxInput(input);
    if (!normalized.ok) return normalized;
    return this.#enqueueNormalized(actor, project.projectId, base.baseId, normalized.value);
  }

  async list(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    input: ListKnowledgeDocumentsInput = {},
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentListItemView[]>> {
    const normalizedProjectId = normalizeScopeId(projectId);
    const normalizedBaseId = normalizeScopeId(baseId);
    if (!normalizedProjectId || !normalizedBaseId) return NOT_FOUND;
    const project = await resolveKnowledgeProject(actor, normalizedProjectId, this.store);
    if (!project) return NOT_FOUND;
    if (!canUseKnowledge(actor, "read")) return FORBIDDEN;

    const base = await this.store.getKnowledgeBase(normalizedBaseId, actor.orgId, project.projectId);
    if (!base) return NOT_FOUND;

    const filters = normalizeListFilters(input);
    if (!filters.ok) return filters;
    const documents = await this.store.listKnowledgeDocuments(
      base.baseId,
      actor.orgId,
      project.projectId,
      filters.value,
    );
    return { ok: true, value: documents.map(toKnowledgeDocumentListItem) };
  }

  async #enqueueNormalized(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    normalized: NormalizedDocumentInput,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentEnqueueResult>> {
    const now = this.#now();
    const record: KnowledgeDocumentRecord = {
      documentId: this.#documentIdGenerator(),
      baseId,
      orgId: actor.orgId,
      projectId,
      title: normalized.title,
      sourceName: normalized.sourceName,
      sourceFormat: normalized.sourceFormat,
      contentText: normalized.contentText,
      contentSha256: sha256(normalized.contentText),
      origin: "source",
      distillationVersion: null,
      status: "queued",
      statusMessage: null,
      parseVersion: KNOWLEDGE_PARSE_VERSION,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
      readyAt: null,
    };
    try {
      return {
        ok: true,
        value: await this.store.enqueueKnowledgeDocument(record, this.#jobIdGenerator()),
      };
    } catch (error) {
      if (isForeignKeyViolation(error)) return NOT_FOUND;
      throw error;
    }
  }

  async status(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    documentId: string,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentStatusView>> {
    const scope = await this.#resolveDocument(actor, "read", projectId, baseId, documentId);
    if (!scope.ok) return scope;
    const processing = await this.store.getKnowledgeDocumentProcessing({
      orgId: actor.orgId,
      projectId: scope.projectId,
      baseId: scope.document.baseId,
      documentId: scope.document.documentId,
      parseVersion: scope.document.parseVersion,
    });
    if (!processing) return NOT_FOUND;
    const { document } = processing;
    return {
      ok: true,
      value: {
        documentId: document.documentId,
        title: document.title,
        sourceName: document.sourceName,
        sourceFormat: document.sourceFormat,
        status: document.status,
        statusMessage: document.statusMessage,
        parseVersion: document.parseVersion,
        updatedAt: document.updatedAt,
        readyAt: document.readyAt,
        processing: {
          jobState: processing.jobState,
          attempts: processing.attempts,
          maxAttempts: processing.maxAttempts,
          retryable: processing.jobState !== "pending" && processing.jobState !== "running",
          chunkCount: processing.chunkCount,
          embeddingCount: processing.embeddingCount,
        },
      },
    };
  }

  async retry(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    documentId: string,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentRetryView>> {
    const scope = await this.#resolveDocument(actor, "write", projectId, baseId, documentId);
    if (!scope.ok) return scope;
    const retried = await this.store.retryKnowledgeDocumentProcessing({
      orgId: actor.orgId,
      projectId: scope.projectId,
      baseId: scope.document.baseId,
      documentId: scope.document.documentId,
      parseVersion: scope.document.parseVersion,
    }, this.#jobIdGenerator(), this.#now());
    if (!retried) return NOT_FOUND;
    return {
      ok: true,
      value: {
        documentId: retried.document.documentId,
        jobState: retried.jobState,
        enqueued: retried.enqueued,
      },
    };
  }

  async #resolveDocument(
    actor: KnowledgeActor,
    action: "read" | "write",
    projectId: string,
    baseId: string,
    documentId: string,
  ): Promise<
    | { ok: true; projectId: string; document: KnowledgeDocumentRecord }
    | KnowledgeDocumentServiceFailure
  > {
    const project = await resolveKnowledgeProject(actor, projectId, this.store);
    if (!project) return NOT_FOUND;
    if (!canUseKnowledge(actor, action)) return FORBIDDEN;
    const normalizedBaseId = baseId.trim();
    const normalizedDocumentId = documentId.trim();
    if (!normalizedBaseId || !normalizedDocumentId) return NOT_FOUND;
    const base = await this.store.getKnowledgeBase(normalizedBaseId, actor.orgId, project.projectId);
    if (!base) return NOT_FOUND;
    const document = await this.store.getKnowledgeDocument(
      normalizedDocumentId,
      base.baseId,
      actor.orgId,
      project.projectId,
    );
    if (!document) return NOT_FOUND;
    return { ok: true, projectId: project.projectId, document };
  }
}

type NormalizedDocumentInput = {
  title: string;
  sourceName: string;
  sourceFormat: KnowledgeSourceFormat;
  contentText: string;
};

function normalizeScopeId(value: string): string | null {
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_SCOPE_ID_LENGTH ? normalized : null;
}

function normalizeListFilters(
  input: ListKnowledgeDocumentsInput,
): KnowledgeDocumentServiceResult<KnowledgeDocumentListFilters> {
  const filters: KnowledgeDocumentListFilters = {};
  if (input.status !== undefined) {
    if (typeof input.status !== "string"
      || !(KNOWLEDGE_DOCUMENT_STATUSES as readonly string[]).includes(input.status)) {
      return { ok: false, code: "invalid", field: "status" };
    }
    filters.status = input.status as KnowledgeDocumentListFilters["status"];
  }
  if (input.origin !== undefined) {
    if (typeof input.origin !== "string"
      || !(KNOWLEDGE_DOCUMENT_ORIGINS as readonly string[]).includes(input.origin)) {
      return { ok: false, code: "invalid", field: "origin" };
    }
    filters.origin = input.origin as KnowledgeDocumentListFilters["origin"];
  }
  if (input.limit !== undefined) {
    const limit = typeof input.limit === "string" && /^\d+$/.test(input.limit)
      ? Number(input.limit)
      : input.limit;
    if (typeof limit !== "number"
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > 500) {
      return { ok: false, code: "invalid", field: "limit" };
    }
    filters.limit = limit;
  }
  return { ok: true, value: filters };
}

function toKnowledgeDocumentListItem(
  document: KnowledgeDocumentRecord,
): KnowledgeDocumentListItemView {
  return {
    documentId: document.documentId,
    title: document.title,
    sourceName: document.sourceName,
    sourceFormat: document.sourceFormat,
    origin: document.origin,
    status: document.status,
    statusMessage: document.statusMessage,
    parseVersion: document.parseVersion,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    readyAt: document.readyAt,
  };
}

function normalizeTextInput(
  input: IngestKnowledgeTextInput,
): KnowledgeDocumentServiceResult<NormalizedDocumentInput> {
  const title = normalizeMetadata(input.title, 500, false);
  if (title === null) return { ok: false, code: "invalid", field: "title" };
  const sourceName = normalizeMetadata(input.sourceName ?? "", 500, true);
  if (sourceName === null) return { ok: false, code: "invalid", field: "sourceName" };
  if (!isInlineSourceFormat(input.sourceFormat)) {
    return { ok: false, code: "invalid", field: "sourceFormat" };
  }
  if (typeof input.content !== "string"
    || Buffer.byteLength(input.content, "utf8") > maxSourceBytes(input.sourceFormat)) {
    return { ok: false, code: "invalid", field: "content" };
  }
  const normalizedContent = input.sourceFormat === "html"
    ? extractKnowledgeHtmlText(input.content)
    : input.content.replace(/\r\n?/g, "\n").trim();
  const contentText = redactSensitiveMemoryText(normalizedContent);
  if (!contentText
    || Buffer.byteLength(contentText, "utf8") > MAX_KNOWLEDGE_TEXT_BYTES) {
    return { ok: false, code: "invalid", field: "content" };
  }
  return { ok: true, value: { title, sourceName, sourceFormat: input.sourceFormat, contentText } };
}

/**
 * ADR-030 Q3 — hosted documents are parsed HERE, in the backend, bounded, and
 * through the same seam the desktop uses locally.
 *
 * `documentText` rather than the Markdown alone because a knowledge document has
 * one body and nowhere else to put the parse notice: a scanned contract stored
 * with an empty body is indistinguishable from a contract with nothing in it,
 * and the row that says "this document is a scan; no text layer exists" is the
 * one a search has to be able to return.
 */
async function normalizePdfInput(
  input: IngestKnowledgePdfInput,
  tenant: string,
): Promise<KnowledgeDocumentServiceResult<NormalizedDocumentInput>> {
  const title = normalizeMetadata(input.title, 500, false);
  if (title === null) return { ok: false, code: "invalid", field: "title" };
  const sourceName = normalizeMetadata(input.sourceName ?? "", 500, true);
  if (sourceName === null) return { ok: false, code: "invalid", field: "sourceName" };
  const pdf = decodeCanonicalPdf(input.contentBase64);
  if (!pdf) return { ok: false, code: "invalid", field: "contentBase64" };

  // ADR-030 Q3 / ADR-027 D12 — admitted, then parsed. The call inside is a
  // synchronous WebAssembly parse that nothing in this process can preempt, so
  // the queue in front of it is bounded and a request that cannot get in is
  // refused now rather than served long after its client stopped waiting.
  const admission = await documentParseGate.run(
    tenant,
    () => parsePdfDocument(pdf, { maxChars: MAX_PDF_EXTRACTED_CHARS }),
  );
  if (!admission.admitted) return { ok: false, code: "busy" };
  const parsed = admission.value;
  // A file we could not parse at all — malformed, encrypted, or not really a PDF
  // — is still rejected. A file we parsed and found to be a SCAN is not: that is
  // a valid document whose honest body is the sentence saying so, and rejecting
  // it as "invalid" was telling the uploader their contract was corrupt.
  if (parsed.classification === "unreadable") {
    return { ok: false, code: "invalid", field: "contentBase64" };
  }
  const normalizedContent = normalizeExtractedPdfText(documentText(parsed));
  const contentText = redactSensitiveMemoryText(normalizedContent);
  if (!contentText
    || Buffer.byteLength(contentText, "utf8") > MAX_KNOWLEDGE_TEXT_BYTES) {
    return { ok: false, code: "invalid", field: "contentBase64" };
  }
  return { ok: true, value: { title, sourceName, sourceFormat: "pdf", contentText } };
}

function normalizeDocxInput(
  input: IngestKnowledgeDocxInput,
): KnowledgeDocumentServiceResult<NormalizedDocumentInput> {
  const title = normalizeMetadata(input.title, 500, false);
  if (title === null) return { ok: false, code: "invalid", field: "title" };
  const sourceName = normalizeMetadata(input.sourceName ?? "", 500, true);
  if (sourceName === null) return { ok: false, code: "invalid", field: "sourceName" };
  const docx = decodeCanonicalDocx(input.contentBase64);
  if (!docx) return { ok: false, code: "invalid", field: "contentBase64" };

  const extracted = extractKnowledgeDocxText(docx);
  if (!extracted) return { ok: false, code: "invalid", field: "contentBase64" };
  const contentText = redactSensitiveMemoryText(extracted);
  if (!contentText
    || Buffer.byteLength(contentText, "utf8") > MAX_KNOWLEDGE_TEXT_BYTES) {
    return { ok: false, code: "invalid", field: "contentBase64" };
  }
  return { ok: true, value: { title, sourceName, sourceFormat: "docx", contentText } };
}

function maxSourceBytes(sourceFormat: KnowledgeInlineSourceFormat): number {
  return sourceFormat === "html" ? MAX_KNOWLEDGE_HTML_BYTES : MAX_KNOWLEDGE_TEXT_BYTES;
}

function normalizeMetadata(value: unknown, max: number, allowEmpty: boolean): string | null {
  if (typeof value !== "string" || value.length > max) return null;
  const normalized = redactSensitiveMemoryText(value.trim());
  if ((!allowEmpty && !normalized) || normalized.length > max) return null;
  return normalized;
}

function isInlineSourceFormat(value: unknown): value is KnowledgeInlineSourceFormat {
  return typeof value === "string"
    && (KNOWLEDGE_INLINE_SOURCE_FORMATS as readonly string[]).includes(value);
}

function decodeCanonicalPdf(value: unknown): Buffer | null {
  if (typeof value !== "string"
    || value.length < 8
    || value.length > MAX_KNOWLEDGE_PDF_BASE64_CHARS
    || value.length % 4 !== 0
    || !hasCanonicalBase64Shape(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 1
    || decoded.length > MAX_KNOWLEDGE_PDF_BYTES
    || decoded.toString("base64") !== value) {
    return null;
  }
  const header = decoded.subarray(0, Math.min(PDF_HEADER_SCAN_BYTES, decoded.length));
  return header.includes(Buffer.from("%PDF-", "ascii")) ? decoded : null;
}

function decodeCanonicalDocx(value: unknown): Buffer | null {
  if (typeof value !== "string"
    || value.length < 8
    || value.length > MAX_KNOWLEDGE_DOCX_BASE64_CHARS
    || value.length % 4 !== 0
    || !hasCanonicalBase64Shape(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 4
    || decoded.length > MAX_KNOWLEDGE_DOCX_BYTES
    || decoded.toString("base64") !== value
    || decoded[0] !== 0x50
    || decoded[1] !== 0x4b
    || decoded[2] !== 0x03
    || decoded[3] !== 0x04) {
    return null;
  }
  return decoded;
}

function hasCanonicalBase64Shape(value: string): boolean {
  const firstPadding = value.indexOf("=");
  const contentEnd = firstPadding === -1 ? value.length : firstPadding;
  const paddingLength = value.length - contentEnd;
  if (paddingLength > 2) return false;
  if (paddingLength === 1 && contentEnd % 4 !== 3) return false;
  if (paddingLength === 2 && contentEnd % 4 !== 2) return false;
  for (let index = 0; index < contentEnd; index += 1) {
    const code = value.charCodeAt(index);
    const allowed = (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f;
    if (!allowed) return false;
  }
  for (let index = contentEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
}

function normalizeExtractedPdfText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "23503";
}
