import type { ConnectorDocument, ConnectorDocumentRecord, ConnectorSource } from '@kinqs/brainrouter-types';
import { searchConnectorDocuments, type ConnectorDocumentSearchFilter } from './documentStore.js';

export interface ConnectorSlimRetrievalOptions extends ConnectorDocumentSearchFilter {
  maxSnippetChars?: number;
}

export interface ConnectorSlimDocument {
  id: string;
  connectorId: string;
  source: ConnectorSource;
  kind: ConnectorDocument['kind'];
  repository?: string;
  title: string;
  url?: string;
  updatedAt?: string;
  snippet: string;
  score: number;
}

export function retrieveConnectorSlimDocuments(
  workspaceRoot: string,
  options?: ConnectorSlimRetrievalOptions,
): ConnectorSlimDocument[] {
  const query = options?.query?.trim() ?? '';
  const maxSnippetChars = Math.max(80, Math.min(2_000, Math.floor(options?.maxSnippetChars ?? 360)));
  return searchConnectorDocuments(workspaceRoot, options)
    .map((doc) => toSlimDocument(doc, query, maxSnippetChars))
    .sort((a, b) => b.score - a.score || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

function toSlimDocument(doc: ConnectorDocumentRecord, query: string, maxSnippetChars: number): ConnectorSlimDocument {
  return {
    id: doc.id,
    connectorId: doc.connectorId,
    source: doc.source,
    kind: doc.kind,
    repository: doc.repository,
    title: doc.title,
    url: doc.url,
    updatedAt: doc.updatedAt,
    snippet: snippetFor(doc, query, maxSnippetChars),
    score: scoreDocument(doc, query),
  };
}

function scoreDocument(doc: ConnectorDocumentRecord, query: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  let score = 0;
  if (doc.title.toLowerCase().includes(q)) score += 5;
  if ((doc.repository ?? '').toLowerCase().includes(q)) score += 3;
  if (doc.text.toLowerCase().includes(q)) score += 2;
  if (JSON.stringify(doc.metadata).toLowerCase().includes(q)) score += 1;
  return score;
}

function snippetFor(doc: ConnectorDocumentRecord, query: string, maxChars: number): string {
  const text = [doc.title, doc.repository, doc.text].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!query) return truncate(text, maxChars);
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return truncate(text, maxChars);
  const radius = Math.floor(maxChars / 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  return `${start > 0 ? '...' : ''}${text.slice(start, end).trim()}${end < text.length ? '...' : ''}`;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3).trimEnd()}...`;
}
