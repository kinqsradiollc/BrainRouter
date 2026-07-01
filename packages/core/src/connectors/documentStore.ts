import type { ConnectorDocument, ConnectorDocumentRecord } from '@kinqs/brainrouter-types';
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';

type ConnectorDocumentStoreFile = Record<string, ConnectorDocumentRecord>;

function documentsFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'connector-documents.json');
}

function readAll(workspaceRoot: string): ConnectorDocumentStoreFile {
  return readJsonFile<ConnectorDocumentStoreFile>(documentsFile(workspaceRoot), {});
}

function writeAll(workspaceRoot: string, store: ConnectorDocumentStoreFile): void {
  writeJsonFile(documentsFile(workspaceRoot), store);
}

export interface ConnectorDocumentFilter {
  connectorId?: string;
  repository?: string;
  kind?: ConnectorDocument['kind'];
}

export interface ConnectorDocumentSearchFilter extends ConnectorDocumentFilter {
  query?: string;
  limit?: number;
}

export function upsertConnectorDocuments(
  workspaceRoot: string,
  documents: ConnectorDocument[],
  options?: { now?: string },
): ConnectorDocumentRecord[] {
  if (documents.length === 0) return [];
  const store = readAll(workspaceRoot);
  const now = options?.now ?? new Date().toISOString();
  const upserted: ConnectorDocumentRecord[] = [];
  for (const doc of documents) {
    const existing = store[doc.id];
    const record: ConnectorDocumentRecord = {
      ...doc,
      metadata: { ...doc.metadata },
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    store[doc.id] = record;
    upserted.push(record);
  }
  writeAll(workspaceRoot, store);
  return upserted;
}

export function getConnectorDocument(workspaceRoot: string, id: string): ConnectorDocumentRecord | undefined {
  return readAll(workspaceRoot)[id];
}

export function listConnectorDocuments(
  workspaceRoot: string,
  filter?: ConnectorDocumentFilter,
): ConnectorDocumentRecord[] {
  return Object.values(readAll(workspaceRoot))
    .filter((doc) => matchesFilter(doc, filter))
    .sort((a, b) => (b.updatedAt ?? b.lastSeenAt).localeCompare(a.updatedAt ?? a.lastSeenAt));
}

export function countConnectorDocuments(workspaceRoot: string, filter?: ConnectorDocumentFilter): number {
  return listConnectorDocuments(workspaceRoot, filter).length;
}

export function searchConnectorDocuments(
  workspaceRoot: string,
  filter?: ConnectorDocumentSearchFilter,
): ConnectorDocumentRecord[] {
  const query = filter?.query?.trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, Math.floor(filter?.limit ?? 50)));
  const rows = listConnectorDocuments(workspaceRoot, filter);
  if (!query) return rows.slice(0, limit);
  return rows
    .filter((doc) => documentSearchText(doc).includes(query))
    .slice(0, limit);
}

export function deleteConnectorDocuments(workspaceRoot: string, connectorId: string): number {
  const store = readAll(workspaceRoot);
  let deleted = 0;
  for (const [id, doc] of Object.entries(store)) {
    if (doc.connectorId !== connectorId) continue;
    delete store[id];
    deleted++;
  }
  if (deleted > 0) writeAll(workspaceRoot, store);
  return deleted;
}

function matchesFilter(doc: ConnectorDocumentRecord, filter?: ConnectorDocumentFilter): boolean {
  if (filter?.connectorId && doc.connectorId !== filter.connectorId) return false;
  if (filter?.repository && doc.repository !== filter.repository) return false;
  if (filter?.kind && doc.kind !== filter.kind) return false;
  return true;
}

function documentSearchText(doc: ConnectorDocumentRecord): string {
  return [
    doc.id,
    doc.title,
    doc.repository,
    doc.url,
    doc.text,
    JSON.stringify(doc.metadata),
  ].filter(Boolean).join('\n').toLowerCase();
}
