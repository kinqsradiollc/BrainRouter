/**
 * C3 — Project-scoped knowledge library for the active Desktop workspace.
 *
 * All server access uses named host queries. The host owns account credentials,
 * organization resolution, and git-remote → Project matching; this renderer
 * receives only whitelisted Project/base/document/search views. Async results
 * are generation-guarded so workspace/base switches cannot paint stale data.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { hostQuery } from '../../lib/hostQuery.js';
import {
  bytesToBase64,
  describeKnowledgeUpload,
  knowledgeTitleFromFileName,
} from './knowledgePanelModel.js';

type LoadState = 'loading' | 'ready' | 'signed-out' | 'no-remote' | 'no-org' | 'unlinked' | 'ambiguous' | 'error';
type DocumentStatus = 'queued' | 'parsing' | 'ready' | 'failed';

interface KnowledgeBaseView {
  baseId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface KnowledgeDocumentView {
  documentId: string;
  title: string;
  sourceName: string;
  sourceFormat: string;
  origin: string;
  status: DocumentStatus;
  statusMessage: string | null;
  parseVersion: number;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
}

interface KnowledgeDocumentStatusView extends KnowledgeDocumentView {
  processing: {
    jobState: string;
    attempts: number;
    maxAttempts: number;
    retryable: boolean;
    chunkCount: number;
    embeddingCount: number;
  };
}

interface WorkspaceResult {
  state: LoadState;
  message?: string;
  project?: { projectId: string; name: string };
  projects?: Array<{ projectId: string; name: string }>;
  bases?: KnowledgeBaseView[];
}

interface DocumentsResult {
  state: LoadState;
  message?: string;
  documents?: KnowledgeDocumentView[];
}

interface SearchResult {
  state: LoadState;
  message?: string;
  search?: {
    mode: string;
    hits: Array<{
      content: string;
      score: number;
      matchedBy: string[];
      citation: {
        documentTitle: string;
        sourceName: string;
        ordinal: number;
      };
    }>;
  };
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? '—' : parsed.toLocaleString();
}

function statusClass(status: string): string {
  return status === 'ready' ? 'ready' : status === 'failed' ? 'failed' : 'working';
}

export function KnowledgePanel({ workspaceKey }: { workspaceKey: string }): React.ReactElement {
  const generationRef = useRef(0);
  const workspaceKeyRef = useRef(workspaceKey);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [workspace, setWorkspace] = useState<WorkspaceResult>({ state: 'loading' });
  const [selectedBaseId, setSelectedBaseId] = useState('');
  const [documents, setDocuments] = useState<KnowledgeDocumentView[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<KnowledgeDocumentStatusView | null>(null);
  const [newBaseName, setNewBaseName] = useState('');
  const [newBaseDescription, setNewBaseDescription] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<SearchResult['search'] | null>(null);

  const refreshWorkspace = useCallback(async () => {
    const scopeKey = workspaceKeyRef.current;
    const generation = ++generationRef.current;
    setWorkspace({ state: 'loading' });
    setBusy('');
    setNotice('');
    const result = await hostQuery<WorkspaceResult>('knowledge-workspace');
    if (generation !== generationRef.current || scopeKey !== workspaceKeyRef.current) return;
    const next = result ?? { state: 'error' as const, message: 'Project knowledge did not respond.' };
    setWorkspace(next);
    const firstBaseId = next.state === 'ready' ? next.bases?.[0]?.baseId ?? '' : '';
    setSelectedBaseId(firstBaseId);
    setDocuments([]);
    setSelectedDocument(null);
    setSearchResult(null);
  }, []);

  const refreshDocuments = useCallback(async (baseId: string) => {
    if (!baseId) {
      setDocuments([]);
      setSelectedDocument(null);
      return;
    }
    const generation = generationRef.current;
    const scopeKey = workspaceKeyRef.current;
    setDocumentsLoading(true);
    const result = await hostQuery<DocumentsResult>('knowledge-documents', { baseId });
    if (generation !== generationRef.current || scopeKey !== workspaceKeyRef.current) return;
    setDocumentsLoading(false);
    if (!result || result.state !== 'ready') {
      setNotice(result?.message ?? 'Knowledge documents did not respond.');
      setDocuments([]);
      return;
    }
    setDocuments(result.documents ?? []);
    setSelectedDocument((current) => (
      current && (result.documents ?? []).some((document) => document.documentId === current.documentId)
        ? current
        : null
    ));
  }, []);

  useEffect(() => {
    workspaceKeyRef.current = workspaceKey;
    ++generationRef.current;
    setWorkspace({ state: 'loading' });
    setSelectedBaseId('');
    setDocuments([]);
    setSelectedDocument(null);
    setSearchResult(null);
    setBusy('');
    setNotice('');
    void refreshWorkspace();
    return () => { ++generationRef.current; };
  }, [workspaceKey, refreshWorkspace]);

  useEffect(() => {
    void refreshDocuments(selectedBaseId);
  }, [selectedBaseId, refreshDocuments]);

  useEffect(() => {
    if (!selectedDocument || (selectedDocument.status !== 'queued' && selectedDocument.status !== 'parsing')) return;
    let cancelled = false;
    const documentId = selectedDocument.documentId;
    const baseId = selectedBaseId;
    const poll = async () => {
      const result = await hostQuery<{ state: LoadState; message?: string; document?: KnowledgeDocumentStatusView }>(
        'knowledge-document-status',
        { baseId, documentId },
      );
      if (cancelled || !result || result.state !== 'ready' || !result.document) return;
      setSelectedDocument(result.document);
      setDocuments((current) => current.map((entry) => (
        entry.documentId === documentId ? { ...entry, ...result.document } : entry
      )));
    };
    const timer = window.setInterval(() => { void poll(); }, 2_000);
    void poll();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedBaseId, selectedDocument?.documentId, selectedDocument?.status]);

  const createBase = async (): Promise<void> => {
    const name = newBaseName.trim();
    if (!name) return;
    setBusy('base');
    setNotice('');
    const generation = generationRef.current;
    const scopeKey = workspaceKeyRef.current;
    const result = await hostQuery<{ state: LoadState; message?: string; base?: KnowledgeBaseView }>(
      'knowledge-base-create',
      { name, description: newBaseDescription.trim() },
    );
    if (generation !== generationRef.current || scopeKey !== workspaceKeyRef.current) return;
    setBusy('');
    if (!result || result.state !== 'ready' || !result.base) {
      setNotice(result?.message ?? 'Knowledge base creation did not respond.');
      return;
    }
    setWorkspace((current) => ({ ...current, bases: [...(current.bases ?? []), result.base!] }));
    ++generationRef.current;
    setSelectedBaseId(result.base.baseId);
    setNewBaseName('');
    setNewBaseDescription('');
    setNotice('Knowledge base created.');
  };

  const upload = async (file: File): Promise<void> => {
    setBusy('upload');
    setNotice('');
    const generation = generationRef.current;
    const scopeKey = workspaceKeyRef.current;
    try {
      const descriptor = describeKnowledgeUpload(file.name, file.type, file.size);
      const args: Record<string, unknown> = {
        baseId: selectedBaseId,
        title: knowledgeTitleFromFileName(file.name),
        sourceName: file.name,
        sourceFormat: descriptor.sourceFormat,
      };
      if (descriptor.binary) {
        args.contentBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      } else {
        args.content = await file.text();
      }
      const result = await hostQuery<{ state: LoadState; message?: string; document?: KnowledgeDocumentView }>(
        'knowledge-ingest',
        args,
      );
      if (generation !== generationRef.current || scopeKey !== workspaceKeyRef.current) return;
      if (!result || result.state !== 'ready' || !result.document) {
        setNotice(result?.message ?? 'Knowledge upload did not respond.');
        return;
      }
      setDocuments((current) => [result.document!, ...current.filter((entry) => entry.documentId !== result.document!.documentId)]);
      await openDocument(result.document);
      setNotice('Document queued for processing.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not read that file.');
    } finally {
      setBusy('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openDocument = async (document: KnowledgeDocumentView): Promise<void> => {
    const generation = generationRef.current;
    const scopeKey = workspaceKeyRef.current;
    setSelectedDocument({ ...document, processing: { jobState: 'missing', attempts: 0, maxAttempts: 0, retryable: false, chunkCount: 0, embeddingCount: 0 } });
    const result = await hostQuery<{ state: LoadState; message?: string; document?: KnowledgeDocumentStatusView }>(
      'knowledge-document-status',
      { baseId: selectedBaseId, documentId: document.documentId },
    );
    if (generation !== generationRef.current || scopeKey !== workspaceKeyRef.current) return;
    if (result?.state === 'ready' && result.document) setSelectedDocument(result.document);
    else if (result?.message) setNotice(result.message);
  };

  const retryDocument = async (): Promise<void> => {
    if (!selectedDocument) return;
    setBusy('retry');
    const generation = generationRef.current;
    const scopeKey = workspaceKeyRef.current;
    const result = await hostQuery<{ state: LoadState; message?: string }>(
      'knowledge-document-retry',
      { baseId: selectedBaseId, documentId: selectedDocument.documentId },
    );
    if (generation !== generationRef.current || scopeKey !== workspaceKeyRef.current) return;
    setBusy('');
    if (!result || result.state !== 'ready') {
      setNotice(result?.message ?? 'Knowledge retry did not respond.');
      return;
    }
    const queued = { ...selectedDocument, status: 'queued' as const, statusMessage: null, processing: { ...selectedDocument.processing, jobState: 'pending', retryable: false } };
    setSelectedDocument(queued);
    setDocuments((current) => current.map((entry) => entry.documentId === queued.documentId ? queued : entry));
    setNotice('Document queued again.');
  };

  const search = async (): Promise<void> => {
    const query = searchQuery.trim();
    if (!query) return;
    setBusy('search');
    setNotice('');
    const generation = generationRef.current;
    const scopeKey = workspaceKeyRef.current;
    const result = await hostQuery<SearchResult>('knowledge-search', { query, baseId: selectedBaseId });
    if (generation !== generationRef.current || scopeKey !== workspaceKeyRef.current) return;
    setBusy('');
    if (!result || result.state !== 'ready') {
      setNotice(result?.message ?? 'Knowledge search did not respond.');
      setSearchResult(null);
      return;
    }
    setSearchResult(result.search ?? { mode: 'lexical', hits: [] });
  };

  if (workspace.state !== 'ready') {
    return (
      <div className="scroll knowledge-panel">
        <div className={`knowledge-state${workspace.state === 'error' ? ' error' : ''}`}>
          <strong>{workspace.state === 'loading' ? 'Loading Project knowledge…' : 'Project knowledge is not ready'}</strong>
          {workspace.message ? <span>{workspace.message}</span> : null}
          {workspace.state === 'ambiguous' && workspace.projects?.length ? (
            <span>{workspace.projects.map((project) => project.name).join(', ')}</span>
          ) : null}
          {workspace.state !== 'loading' ? <button className="btn" onClick={() => void refreshWorkspace()}>Try again</button> : null}
        </div>
      </div>
    );
  }

  const bases = workspace.bases ?? [];
  return (
    <div className="scroll knowledge-panel">
      <div className="knowledge-heading">
        <div>
          <span className="knowledge-eyebrow">Project knowledge</span>
          <strong>{workspace.project?.name ?? 'Project'}</strong>
        </div>
        <button className="icon-btn" title="Refresh Project knowledge" disabled={Boolean(busy)} onClick={() => void refreshWorkspace()}>↻</button>
      </div>

      <section className="knowledge-section">
        <div className="knowledge-section-title"><span>Bases</span><small>{bases.length}</small></div>
        <div className="knowledge-base-list">
          {bases.map((base) => (
            <button key={base.baseId} className={`knowledge-base${selectedBaseId === base.baseId ? ' active' : ''}`} onClick={() => {
              ++generationRef.current;
              setBusy('');
              setNotice('');
              setSelectedBaseId(base.baseId);
              setSelectedDocument(null);
              setSearchResult(null);
            }}>
              <strong>{base.name}</strong>
              <span>{base.description || 'No description'}</span>
            </button>
          ))}
        </div>
        <div className="knowledge-create">
          <input className="filter" value={newBaseName} maxLength={200} placeholder="New base name" onChange={(event) => setNewBaseName(event.target.value)} />
          <input className="filter" value={newBaseDescription} maxLength={2_000} placeholder="Description (optional)" onChange={(event) => setNewBaseDescription(event.target.value)} />
          <button className="btn primary" disabled={Boolean(busy) || !newBaseName.trim()} onClick={() => void createBase()}>
            {busy === 'base' ? 'Creating…' : 'Create base'}
          </button>
        </div>
      </section>

      {selectedBaseId ? (
        <>
          <section className="knowledge-section">
            <div className="knowledge-section-title">
              <span>Documents</span><small>{documents.length}</small>
              <label className={`btn primary knowledge-upload${busy ? ' disabled' : ''}`}>
                {busy === 'upload' ? 'Uploading…' : 'Upload'}
                <input
                  ref={fileInputRef}
                  type="file"
                  disabled={Boolean(busy)}
                  accept=".txt,.md,.markdown,.html,.htm,.pdf,.docx,text/plain,text/markdown,text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(file);
                  }}
                />
              </label>
            </div>
            {documentsLoading && documents.length === 0 ? <div className="empty">Loading documents…</div> : null}
            {!documentsLoading && documents.length === 0 ? <div className="empty">No documents in this base yet.</div> : null}
            <div className="knowledge-document-list">
              {documents.map((document) => (
                <button key={document.documentId} disabled={Boolean(busy)} className={`knowledge-document${selectedDocument?.documentId === document.documentId ? ' active' : ''}`} onClick={() => void openDocument(document)}>
                  <span className={`knowledge-status ${statusClass(document.status)}`}>{document.status}</span>
                  <strong>{document.title}</strong>
                  <span>{document.sourceName} · {document.sourceFormat.toUpperCase()}</span>
                </button>
              ))}
            </div>
            {selectedDocument ? (
              <div className="knowledge-detail">
                <div className="knowledge-detail-head">
                  <strong>{selectedDocument.title}</strong>
                  {selectedDocument.status !== 'ready' && selectedDocument.processing.retryable ? (
                    <button className="btn" disabled={Boolean(busy)} onClick={() => void retryDocument()}>
                      {busy === 'retry' ? 'Retrying…' : 'Retry'}
                    </button>
                  ) : null}
                </div>
                {selectedDocument.statusMessage ? <div className="knowledge-error">{selectedDocument.statusMessage}</div> : null}
                <dl className="knowledge-stats">
                  <div><dt>Job</dt><dd>{selectedDocument.processing.jobState}</dd></div>
                  <div><dt>Attempts</dt><dd>{selectedDocument.processing.attempts}/{selectedDocument.processing.maxAttempts}</dd></div>
                  <div><dt>Chunks</dt><dd>{selectedDocument.processing.chunkCount}</dd></div>
                  <div><dt>Embeddings</dt><dd>{selectedDocument.processing.embeddingCount}</dd></div>
                </dl>
                <span className="knowledge-date">Updated {formatDate(selectedDocument.updatedAt)}</span>
              </div>
            ) : null}
          </section>

          <section className="knowledge-section">
            <div className="knowledge-section-title"><span>Search preview</span></div>
            <div className="knowledge-search">
              <input
                className="filter"
                value={searchQuery}
                maxLength={4_000}
                placeholder="Search this base…"
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void search(); }}
              />
              <button className="btn primary" disabled={Boolean(busy) || !searchQuery.trim()} onClick={() => void search()}>
                {busy === 'search' ? 'Searching…' : 'Search'}
              </button>
            </div>
            {searchResult ? (
              <div className="knowledge-results">
                <span className="knowledge-mode">{searchResult.mode} · {searchResult.hits.length} result{searchResult.hits.length === 1 ? '' : 's'}</span>
                {searchResult.hits.length === 0 ? <div className="empty">No matching knowledge.</div> : null}
                {searchResult.hits.map((hit, index) => (
                  <article key={`${hit.citation.documentTitle}:${hit.citation.ordinal}:${index}`} className="knowledge-hit">
                    <p>{hit.content}</p>
                    <footer>{hit.citation.documentTitle} · {hit.citation.sourceName} · chunk {hit.citation.ordinal + 1}</footer>
                  </article>
                ))}
              </div>
            ) : null}
          </section>
        </>
      ) : <div className="empty">Create a knowledge base to upload and search documents.</div>}

      {notice ? <div className="knowledge-notice" role="status">{notice}</div> : null}
      <div className="sched-note">Uploads are bounded to TXT/Markdown/PDF 2 MB, HTML 1 MB, and DOCX 4 MB. Processing runs asynchronously.</div>
    </div>
  );
}
