import { createHash, randomUUID } from "node:crypto";
import { extractPdf } from "@kinqs/brainrouter-core/attachment";
import { redactSensitiveMemoryText } from "../../memory/util/redaction.js";
import { canUseKnowledge } from "../contracts/actor.js";
import type { KnowledgeActor } from "../contracts/actor.js";
import {
  KNOWLEDGE_PARSE_VERSION,
  KNOWLEDGE_INLINE_SOURCE_FORMATS,
  MAX_KNOWLEDGE_HTML_BYTES,
  MAX_KNOWLEDGE_PDF_BASE64_CHARS,
  MAX_KNOWLEDGE_PDF_BYTES,
  MAX_KNOWLEDGE_TEXT_BYTES,
} from "../contracts/document.js";
import type {
  IngestKnowledgePdfInput,
  IngestKnowledgeTextInput,
  KnowledgeDocumentEnqueueResult,
  KnowledgeDocumentRecord,
  KnowledgeDocumentRetryView,
  KnowledgeDocumentServiceFailure,
  KnowledgeDocumentServiceResult,
  KnowledgeDocumentStatusView,
  KnowledgeInlineSourceFormat,
  KnowledgeSourceFormat,
} from "../contracts/document.js";
import type { KnowledgeDocumentStore } from "../store.js";
import { extractKnowledgeHtmlText } from "./html-parser.js";
import { resolveKnowledgeProject } from "./project-access.js";

const NOT_FOUND: KnowledgeDocumentServiceFailure = { ok: false, code: "not_found" };
const FORBIDDEN: KnowledgeDocumentServiceFailure = { ok: false, code: "forbidden" };
const PDF_HEADER_SCAN_BYTES = 1024;
const MAX_PDF_EXTRACTED_CHARS = Math.floor(MAX_KNOWLEDGE_TEXT_BYTES / 2);

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

    const normalized = normalizePdfInput(input);
    if (!normalized.ok) return normalized;
    return this.#enqueueNormalized(actor, project.projectId, base.baseId, normalized.value);
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

function normalizePdfInput(
  input: IngestKnowledgePdfInput,
): KnowledgeDocumentServiceResult<NormalizedDocumentInput> {
  const title = normalizeMetadata(input.title, 500, false);
  if (title === null) return { ok: false, code: "invalid", field: "title" };
  const sourceName = normalizeMetadata(input.sourceName ?? "", 500, true);
  if (sourceName === null) return { ok: false, code: "invalid", field: "sourceName" };
  const pdf = decodeCanonicalPdf(input.contentBase64);
  if (!pdf) return { ok: false, code: "invalid", field: "contentBase64" };

  const extracted = extractPdf(pdf, { maxChars: MAX_PDF_EXTRACTED_CHARS });
  const normalizedContent = normalizeExtractedPdfText(extracted.text);
  const contentText = redactSensitiveMemoryText(normalizedContent);
  if (!contentText
    || Buffer.byteLength(contentText, "utf8") > MAX_KNOWLEDGE_TEXT_BYTES) {
    return { ok: false, code: "invalid", field: "contentBase64" };
  }
  return { ok: true, value: { title, sourceName, sourceFormat: "pdf", contentText } };
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
