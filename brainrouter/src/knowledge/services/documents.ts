import { createHash, randomUUID } from "node:crypto";
import { redactSensitiveMemoryText } from "../../memory/util/redaction.js";
import { canUseKnowledge } from "../contracts/actor.js";
import type { KnowledgeActor } from "../contracts/actor.js";
import {
  KNOWLEDGE_PARSE_VERSION,
  KNOWLEDGE_SOURCE_FORMATS,
  MAX_KNOWLEDGE_TEXT_BYTES,
} from "../contracts/document.js";
import type {
  IngestKnowledgeTextInput,
  KnowledgeDocumentEnqueueResult,
  KnowledgeDocumentRecord,
  KnowledgeDocumentServiceFailure,
  KnowledgeDocumentServiceResult,
  KnowledgeSourceFormat,
} from "../contracts/document.js";
import type { KnowledgeDocumentStore } from "../store.js";
import { resolveKnowledgeProject } from "./project-access.js";

const NOT_FOUND: KnowledgeDocumentServiceFailure = { ok: false, code: "not_found" };
const FORBIDDEN: KnowledgeDocumentServiceFailure = { ok: false, code: "forbidden" };

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
    const now = this.#now();
    const record: KnowledgeDocumentRecord = {
      documentId: this.#documentIdGenerator(),
      baseId: base.baseId,
      orgId: actor.orgId,
      projectId: project.projectId,
      title: normalized.value.title,
      sourceName: normalized.value.sourceName,
      sourceFormat: normalized.value.sourceFormat,
      contentText: normalized.value.contentText,
      contentSha256: sha256(normalized.value.contentText),
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
}

type NormalizedTextInput = {
  title: string;
  sourceName: string;
  sourceFormat: KnowledgeSourceFormat;
  contentText: string;
};

function normalizeTextInput(
  input: IngestKnowledgeTextInput,
): KnowledgeDocumentServiceResult<NormalizedTextInput> {
  const title = normalizeMetadata(input.title, 500, false);
  if (title === null) return { ok: false, code: "invalid", field: "title" };
  const sourceName = normalizeMetadata(input.sourceName ?? "", 500, true);
  if (sourceName === null) return { ok: false, code: "invalid", field: "sourceName" };
  if (!isSourceFormat(input.sourceFormat)) {
    return { ok: false, code: "invalid", field: "sourceFormat" };
  }
  if (typeof input.content !== "string"
    || Buffer.byteLength(input.content, "utf8") > MAX_KNOWLEDGE_TEXT_BYTES) {
    return { ok: false, code: "invalid", field: "content" };
  }
  const normalizedContent = input.content.replace(/\r\n?/g, "\n").trim();
  const contentText = redactSensitiveMemoryText(normalizedContent);
  if (!contentText
    || Buffer.byteLength(contentText, "utf8") > MAX_KNOWLEDGE_TEXT_BYTES) {
    return { ok: false, code: "invalid", field: "content" };
  }
  return { ok: true, value: { title, sourceName, sourceFormat: input.sourceFormat, contentText } };
}

function normalizeMetadata(value: unknown, max: number, allowEmpty: boolean): string | null {
  if (typeof value !== "string" || value.length > max) return null;
  const normalized = redactSensitiveMemoryText(value.trim());
  if ((!allowEmpty && !normalized) || normalized.length > max) return null;
  return normalized;
}

function isSourceFormat(value: unknown): value is KnowledgeSourceFormat {
  return typeof value === "string"
    && (KNOWLEDGE_SOURCE_FORMATS as readonly string[]).includes(value);
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "23503";
}
