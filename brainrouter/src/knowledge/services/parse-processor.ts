import { createHash } from "node:crypto";
import { chunkSource } from "../../memory/source/chunker.js";
import {
  KNOWLEDGE_PARSE_VERSION,
  type KnowledgeChunkInput,
  type KnowledgeDocumentRecord,
  type KnowledgeParseCommitResult,
  type KnowledgeParseJobInput,
} from "../contracts/document.js";

const SAFE_FAILURE_MESSAGE = "Knowledge document parsing failed.";
const MAX_SCOPE_ID_LENGTH = 512;

export interface KnowledgeParseProcessorStore {
  getKnowledgeDocument(
    documentId: string,
    baseId: string,
    orgId: string,
    projectId: string,
  ): Promise<KnowledgeDocumentRecord | null>;
  markKnowledgeDocumentParsing(
    input: KnowledgeParseJobInput,
    updatedAt: string,
  ): Promise<KnowledgeDocumentRecord | null>;
  commitKnowledgeDocumentParse(
    input: KnowledgeParseJobInput,
    chunks: KnowledgeChunkInput[],
    readyAt: string,
  ): Promise<KnowledgeParseCommitResult | null>;
  failKnowledgeDocumentParse(
    input: KnowledgeParseJobInput,
    statusMessage: string,
    updatedAt: string,
  ): Promise<KnowledgeDocumentRecord | null>;
}

export interface KnowledgeParseProcessorOptions {
  now?: () => string;
}

export async function processKnowledgeParseJob(
  rawInput: unknown,
  store: KnowledgeParseProcessorStore,
  options: KnowledgeParseProcessorOptions = {},
): Promise<{ documentId: string; chunksWritten: number; alreadyReady: boolean; status: "ready" }> {
  const input = parseJobInput(rawInput);
  const now = options.now ?? (() => new Date().toISOString());
  let document: KnowledgeDocumentRecord | null = null;
  try {
    document = await store.getKnowledgeDocument(
      input.documentId,
      input.baseId,
      input.orgId,
      input.projectId,
    );
    if (!document || document.parseVersion !== input.parseVersion) {
      throw new Error("Knowledge document is unavailable for this parse job.");
    }
    const parsing = await store.markKnowledgeDocumentParsing(input, now());
    if (!parsing || parsing.parseVersion !== input.parseVersion) {
      throw new Error("Knowledge document is unavailable for this parse job.");
    }
    const chunks = parsing.status === "ready" ? [] : buildKnowledgeChunks(parsing);
    if (parsing.status !== "ready" && chunks.length === 0) {
      throw new Error("Knowledge document produced no parseable chunks.");
    }
    const committed = await store.commitKnowledgeDocumentParse(input, chunks, now());
    if (!committed) throw new Error("Knowledge document is unavailable for parse commit.");
    return {
      documentId: committed.document.documentId,
      chunksWritten: committed.chunksWritten,
      alreadyReady: committed.alreadyReady,
      status: "ready",
    };
  } catch (error) {
    if (document?.parseVersion === input.parseVersion && document.status !== "ready") {
      await store.failKnowledgeDocumentParse(input, SAFE_FAILURE_MESSAGE, now()).catch(() => null);
    }
    throw error;
  }
}

export function buildKnowledgeChunks(document: KnowledgeDocumentRecord): KnowledgeChunkInput[] {
  return chunkSource(document.contentText).map((chunk, ordinal) => {
    const contentSha256 = sha256(chunk.content);
    return {
      chunkId: `kchunk_${sha256(`${document.documentId}:${ordinal}:${contentSha256}`).slice(0, 40)}`,
      ordinal,
      content: chunk.content,
      contentSha256,
      tokenCount: chunk.tokenCount,
      charStart: null,
      charEnd: null,
      locator: {
        sourceFormat: document.sourceFormat,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      },
    };
  });
}

export function parseJobInput(value: unknown): KnowledgeParseJobInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid knowledge parse job input.");
  }
  const record = value as Record<string, unknown>;
  const orgId = boundedId(record.orgId);
  const projectId = boundedId(record.projectId);
  const baseId = boundedId(record.baseId);
  const documentId = boundedId(record.documentId);
  if (!orgId || !projectId || !baseId || !documentId
    || record.parseVersion !== KNOWLEDGE_PARSE_VERSION) {
    throw new Error("Invalid knowledge parse job input.");
  }
  return { orgId, projectId, baseId, documentId, parseVersion: KNOWLEDGE_PARSE_VERSION };
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_SCOPE_ID_LENGTH ? normalized : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
