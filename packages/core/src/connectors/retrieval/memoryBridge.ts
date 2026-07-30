import { createHash } from 'node:crypto';
import type {
  CognitiveRecord,
  ConnectorDocumentRecord,
  MemoryEvidence,
  MemoryImport,
  MemoryOperation,
  MemoryType,
  MemoryVisibility,
} from '@kinqs/brainrouter-types';
import { workspaceTagFromPath } from '@kinqs/brainrouter-types';
import { searchConnectorDocuments, type ConnectorDocumentSearchFilter } from '../store/documentStore.js';

export interface ConnectorMemoryExportOptions extends ConnectorDocumentSearchFilter {
  userId?: string;
  sessionKey?: string;
  now?: string;
  /** Explicit tenant scope for server-hosted connectors. */
  orgId?: string | null;
  visibility?: MemoryVisibility;
  /** `undefined` keeps the local workspace hash; `null` is intentionally org-wide. */
  workspaceTag?: string | null;
  projectTag?: string | null;
}

export interface ConnectorMemoryExportResult {
  data: MemoryImport;
  recordCount: number;
  evidenceCount: number;
  operationCount: number;
}

export function exportConnectorDocumentsForMemory(
  workspaceRoot: string,
  options?: ConnectorMemoryExportOptions,
): ConnectorMemoryExportResult {
  const userId = options?.userId?.trim() || 'default';
  const now = options?.now ?? new Date().toISOString();
  const documents = searchConnectorDocuments(workspaceRoot, options);
  const memories = documents.map((doc) => connectorDocumentToMemoryRecord(doc, {
    userId,
    workspaceRoot,
    sessionKey: options?.sessionKey,
    orgId: options?.orgId,
    visibility: options?.visibility,
    workspaceTag: options?.workspaceTag,
    projectTag: options?.projectTag,
    now,
  }));
  const evidence = documents.flatMap((doc) => connectorDocumentEvidence(doc, {
    userId,
    memoryId: connectorMemoryId(doc.id),
    now,
  }));
  const operations: MemoryOperation[] = documents.length ? [{
    id: connectorOperationId(documents, now),
    userId,
    recordId: null,
    operation: 'connector_import',
    actor: 'system',
    sessionKey: options?.sessionKey ?? '',
    reason: 'connector documents indexed for memory recall',
    createdAt: now,
    metadata: {
      connectorIds: [...new Set(documents.map((doc) => doc.connectorId))],
      documents: documents.length,
      workspaceRoot,
    },
  }] : [];

  return {
    data: { version: 1, memories, evidence, operations },
    recordCount: memories.length,
    evidenceCount: evidence.length,
    operationCount: operations.length,
  };
}

export function connectorDocumentToMemoryRecord(
  doc: ConnectorDocumentRecord,
  options: {
    userId: string;
    workspaceRoot?: string;
    sessionKey?: string;
    now?: string;
    orgId?: string | null;
    visibility?: MemoryVisibility;
    workspaceTag?: string | null;
    projectTag?: string | null;
  },
): CognitiveRecord {
  const now = options.now ?? new Date().toISOString();
  const filePath = typeof doc.metadata.path === 'string' ? doc.metadata.path : undefined;
  const content = connectorMemoryContent(doc);
  return {
    id: connectorMemoryId(doc.id),
    userId: options.userId,
    sessionKey: options.sessionKey ?? '',
    sessionId: '',
    content,
    type: memoryTypeForDocument(doc),
    priority: priorityForDocument(doc),
    sceneName: `${doc.source} connector`,
    skillTag: 'connector',
    halfLifeDays: null,
    supersededBy: null,
    invalidAt: null,
    timestampStr: doc.updatedAt ?? doc.lastSeenAt ?? now,
    timestampStart: doc.updatedAt ?? doc.lastSeenAt ?? now,
    timestampEnd: doc.updatedAt ?? doc.lastSeenAt ?? now,
    createdTime: doc.firstSeenAt ?? now,
    updatedTime: doc.updatedAt ?? doc.lastSeenAt ?? now,
    metadata: {
      ...doc.metadata,
      connectorDocumentId: doc.id,
      connectorId: doc.connectorId,
      connectorSource: doc.source,
      connectorKind: doc.kind,
      repository: doc.repository,
      url: doc.url,
    },
    confidence: 0.8,
    status: 'active',
    sourceKind: 'source_file',
    verificationStatus: 'unverified',
    repoPaths: doc.repository ? [doc.repository] : [],
    filePaths: filePath ? [filePath] : [],
    commands: [],
    citationCount: 0,
    lastCitedAt: null,
    neverCitedCount: 0,
    archived: false,
    workspaceTag: options.workspaceTag === undefined
      ? workspaceTagFromPath(options.workspaceRoot)
      : options.workspaceTag,
    projectTag: options.projectTag ?? null,
    orgId: options.orgId ?? null,
    visibility: options.visibility ?? 'private',
  };
}

export function connectorMemoryId(documentId: string): string {
  return `connector_memory_${stableHash(documentId)}`;
}

function connectorDocumentEvidence(
  doc: ConnectorDocumentRecord,
  options: { userId: string; memoryId: string; now: string },
): MemoryEvidence[] {
  const refs: MemoryEvidence[] = [{
    id: `connector_evidence_${stableHash(`${doc.id}:document`)}`,
    userId: options.userId,
    recordId: options.memoryId,
    kind: doc.url ? 'url' : 'other',
    ref: doc.url ?? doc.id,
    excerpt: truncate(doc.text, 1_000),
    observedAt: doc.updatedAt ?? doc.lastSeenAt ?? options.now,
    metadata: {
      connectorDocumentId: doc.id,
      connectorId: doc.connectorId,
      connectorSource: doc.source,
      connectorKind: doc.kind,
      repository: doc.repository,
    },
  }];
  if (typeof doc.metadata.path === 'string') {
    refs.push({
      id: `connector_evidence_${stableHash(`${doc.id}:file:${doc.metadata.path}`)}`,
      userId: options.userId,
      recordId: options.memoryId,
      kind: 'file',
      ref: doc.metadata.path,
      excerpt: truncate(doc.text, 1_000),
      observedAt: doc.updatedAt ?? doc.lastSeenAt ?? options.now,
      metadata: {
        connectorDocumentId: doc.id,
        connectorId: doc.connectorId,
        repository: doc.repository,
      },
    });
  }
  return refs;
}

function connectorMemoryContent(doc: ConnectorDocumentRecord): string {
  return [
    `${labelForDocument(doc)}: ${doc.title}`,
    doc.repository ? `Repository: ${doc.repository}` : '',
    doc.url ? `URL: ${doc.url}` : '',
    doc.text,
  ].filter(Boolean).join('\n\n');
}

function labelForDocument(doc: ConnectorDocumentRecord): string {
  if (doc.kind === 'pull-request') return 'GitHub pull request';
  if (doc.kind === 'issue') return 'GitHub issue';
  return 'Connector file';
}

function memoryTypeForDocument(doc: ConnectorDocumentRecord): MemoryType {
  if (doc.kind === 'file') return 'source_evidence';
  if (doc.kind === 'pull-request') return 'review_comment';
  return 'task_state';
}

function priorityForDocument(doc: ConnectorDocumentRecord): number {
  if (doc.kind === 'file') return 70;
  if (doc.kind === 'pull-request') return 66;
  return 64;
}

function connectorOperationId(documents: ConnectorDocumentRecord[], now: string): string {
  const basis = documents.map((doc) => doc.id).sort().join('\n');
  return `connector_operation_${stableHash(`${now}\n${basis}`)}`;
}

function stableHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 24);
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3).trimEnd()}...`;
}
