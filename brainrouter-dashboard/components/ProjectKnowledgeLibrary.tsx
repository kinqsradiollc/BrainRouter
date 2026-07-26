"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useKnowledgeBases,
  useKnowledgeDocuments,
  useKnowledgeDocumentStatus,
  useKnowledgeSearch,
} from "@kinqs/brainrouter-hooks";
import type {
  KnowledgeDocumentOrigin,
  KnowledgeDocumentStatus,
  KnowledgeInlineSourceFormat,
} from "@kinqs/brainrouter-sdk";
import { getClient } from "../lib/client";
import { DataTable, StatusBadge } from "./Analytics";
import { EmptyState } from "./EmptyState";
import { PremiumButton } from "./PremiumButton";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 1 * 1024 * 1024;
const MAX_PDF_BYTES = 2 * 1024 * 1024;
const MAX_DOCX_BYTES = 4 * 1024 * 1024;

interface ProjectKnowledgeLibraryProps {
  orgId: string;
  projectId: string;
}

interface BaseSelection {
  scopeKey: string;
  baseId: string;
}

interface DocumentSelection {
  scopeKey: string;
  documentId: string;
}

type UploadInput =
  | {
      kind: "text";
      input: {
        title: string;
        sourceName: string;
        sourceFormat: KnowledgeInlineSourceFormat;
        content: string;
      };
    }
  | {
      kind: "pdf" | "docx";
      input: {
        title: string;
        sourceName: string;
        contentBase64: string;
      };
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayApiError(error: string | null, fallback: string): string | null {
  if (!error) return null;
  const normalized = error.trim();
  return /<(?:!doctype|html|body|pre)\b/i.test(normalized) ? fallback : normalized;
}

function titleFromFileName(fileName: string): string {
  const title = fileName.replace(/\.[^.]+$/, "").trim();
  return (title || fileName).slice(0, 500);
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function readUpload(file: File): Promise<UploadInput> {
  if (!file.name || file.name.length > 500) {
    throw new Error("Choose a file whose name is 500 characters or fewer.");
  }
  const lowerName = file.name.toLowerCase();
  const title = titleFromFileName(file.name);
  if (lowerName.endsWith(".pdf") || file.type === "application/pdf") {
    if (file.size > MAX_PDF_BYTES) throw new Error("PDF files must be 2 MB or smaller.");
    return {
      kind: "pdf",
      input: {
        title,
        sourceName: file.name,
        contentBase64: bytesToBase64(await file.arrayBuffer()),
      },
    };
  }
  if (
    lowerName.endsWith(".docx")
    || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    if (file.size > MAX_DOCX_BYTES) throw new Error("DOCX files must be 4 MB or smaller.");
    return {
      kind: "docx",
      input: {
        title,
        sourceName: file.name,
        contentBase64: bytesToBase64(await file.arrayBuffer()),
      },
    };
  }

  const sourceFormat: KnowledgeInlineSourceFormat =
    lowerName.endsWith(".html") || lowerName.endsWith(".htm") || file.type === "text/html"
      ? "html"
      : lowerName.endsWith(".md") || lowerName.endsWith(".markdown") || file.type === "text/markdown"
        ? "markdown"
        : "text";
  const maxBytes = sourceFormat === "html" ? MAX_HTML_BYTES : MAX_TEXT_BYTES;
  if (file.size > maxBytes) {
    throw new Error(`${sourceFormat.toUpperCase()} files must be ${maxBytes / 1024 / 1024} MB or smaller.`);
  }
  return {
    kind: "text",
    input: {
      title,
      sourceName: file.name,
      sourceFormat,
      content: await file.text(),
    },
  };
}

function statusTone(status: KnowledgeDocumentStatus): "ok" | "warn" | "danger" | "info" {
  if (status === "ready") return "ok";
  if (status === "failed") return "danger";
  if (status === "parsing") return "info";
  return "warn";
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "—" : parsed.toLocaleString();
}

export function ProjectKnowledgeLibrary({ orgId, projectId }: ProjectKnowledgeLibraryProps) {
  const client = useMemo(() => getClient().withActiveOrg(orgId), [orgId]);
  const projectScopeKey = `${orgId}\u0000${projectId}`;
  const [baseSelection, setBaseSelection] = useState<BaseSelection>({ scopeKey: "", baseId: "" });
  const [documentSelection, setDocumentSelection] = useState<DocumentSelection>({
    scopeKey: "",
    documentId: "",
  });
  const [newBaseName, setNewBaseName] = useState("");
  const [newBaseDescription, setNewBaseDescription] = useState("");
  const [statusFilter, setStatusFilter] = useState<KnowledgeDocumentStatus | "">("");
  const [originFilter, setOriginFilter] = useState<KnowledgeDocumentOrigin | "">("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const baseState = useKnowledgeBases(client, projectId);
  const selectedBaseId = baseSelection.scopeKey === projectScopeKey
    ? baseSelection.baseId
    : baseState.bases[0]?.baseId ?? "";
  const documentScopeKey = `${projectScopeKey}\u0000${selectedBaseId}`;
  const documentFilters = useMemo(() => ({
    status: statusFilter || undefined,
    origin: originFilter || undefined,
    limit: 200,
  }), [originFilter, statusFilter]);
  const documentState = useKnowledgeDocuments(
    client,
    projectId,
    selectedBaseId,
    documentFilters,
  );
  const selectedDocumentId = documentSelection.scopeKey === documentScopeKey
    ? documentSelection.documentId
    : documentState.documents[0]?.documentId ?? "";
  const statusState = useKnowledgeDocumentStatus(
    client,
    projectId,
    selectedBaseId,
    selectedDocumentId,
  );
  const searchState = useKnowledgeSearch(client, projectId);

  useEffect(() => {
    searchState.clear();
  }, [searchState.clear, selectedBaseId]);

  useEffect(() => {
    if (
      statusState.document?.status !== "queued"
      && statusState.document?.status !== "parsing"
    ) return;
    const timer = window.setInterval(() => {
      statusState.reload();
      documentState.reload();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [
    documentState.reload,
    statusState.document?.status,
    statusState.reload,
  ]);

  const createBase = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newBaseName.trim();
    if (!name) return;
    try {
      const base = await baseState.createBase({
        name,
        description: newBaseDescription.trim() || undefined,
      });
      setBaseSelection({ scopeKey: projectScopeKey, baseId: base.baseId });
      setNewBaseName("");
      setNewBaseDescription("");
    } catch {
      // The hook exposes the stable API error next to this form.
    }
  };

  const uploadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !selectedBaseId) return;
    setUploadError(null);
    try {
      const upload = await readUpload(file);
      const response = upload.kind === "text"
        ? await documentState.ingestText(upload.input)
        : upload.kind === "pdf"
          ? await documentState.ingestPdf(upload.input)
          : await documentState.ingestDocx(upload.input);
      setDocumentSelection({
        scopeKey: documentScopeKey,
        documentId: response.document.documentId,
      });
    } catch (error) {
      setUploadError(errorMessage(error));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const search = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query || !projectId) return;
    try {
      await searchState.search({
        query,
        baseIds: selectedBaseId ? [selectedBaseId] : undefined,
        limit: 8,
      });
    } catch {
      // The hook exposes the stable API error next to the search form.
    }
  };
  const baseError = displayApiError(
    baseState.error,
    "The Project knowledge service is unavailable on this BrainRouter server.",
  );
  const documentError = displayApiError(
    documentState.error,
    "Documents could not be loaded from the selected knowledge base.",
  );
  const statusError = displayApiError(
    statusState.error,
    "Processing status could not be loaded for this document.",
  );
  const searchError = displayApiError(
    searchState.error,
    "Project knowledge search is unavailable on this BrainRouter server.",
  );

  if (!projectId) {
    return (
      <section className="project-knowledge-library" aria-labelledby="project-library-title">
        <div className="knowledge-section-heading">
          <span>Project library</span>
          <h2 id="project-library-title">Files agents can search with citations</h2>
        </div>
        <EmptyState
          title="Choose a Project"
          description="Select one Project above to manage its knowledge bases, documents, processing status, and search results."
        />
      </section>
    );
  }

  return (
    <section className="project-knowledge-library" aria-labelledby="project-library-title">
      <div className="knowledge-section-heading project-knowledge-library__heading">
        <div>
          <span>Project library</span>
          <h2 id="project-library-title">Files agents can search with citations</h2>
          <p>Upload bounded text, Markdown, HTML, PDF, or DOCX sources. Processing stays inside the selected organization and Project.</p>
        </div>
        <PremiumButton
          size="small"
          variant="ghost"
          onClick={() => {
            baseState.reload();
            documentState.reload();
            statusState.reload();
          }}
          disabled={baseState.isLoading || documentState.isLoading}
        >
          Refresh
        </PremiumButton>
      </div>

      <div className="project-knowledge-library__controls">
        <label>
          <span>Knowledge base</span>
          <select
            className="settings-select"
            value={selectedBaseId}
            onChange={(event) => {
              setBaseSelection({ scopeKey: projectScopeKey, baseId: event.target.value });
              setDocumentSelection({ scopeKey: "", documentId: "" });
            }}
            disabled={baseState.isLoading || baseState.bases.length === 0}
          >
            {baseState.bases.length === 0 && (
              <option value="">{baseState.isLoading ? "Loading bases…" : "No bases yet"}</option>
            )}
            {baseState.bases.map((base) => (
              <option key={base.baseId} value={base.baseId}>{base.name}</option>
            ))}
          </select>
        </label>

        <form className="project-knowledge-library__base-form" onSubmit={(event) => void createBase(event)}>
          <label>
            <span>New base</span>
            <input
              className="settings-input"
              value={newBaseName}
              maxLength={200}
              placeholder="e.g. Product handbook"
              onChange={(event) => setNewBaseName(event.target.value)}
            />
          </label>
          <label>
            <span>Description</span>
            <input
              className="settings-input"
              value={newBaseDescription}
              maxLength={4000}
              placeholder="Optional purpose"
              onChange={(event) => setNewBaseDescription(event.target.value)}
            />
          </label>
          <PremiumButton type="submit" size="small" variant="primary" disabled={!newBaseName.trim() || baseState.isMutating}>
            {baseState.isMutating ? "Creating…" : "Create base"}
          </PremiumButton>
        </form>
      </div>

      {baseError && (
        <div className="settings-note settings-note--error" role="alert">{baseError}</div>
      )}

      {selectedBaseId && (
        <>
          <div className="project-knowledge-library__toolbar">
            <label className="project-knowledge-library__upload">
              <span>Upload a source</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.markdown,.html,.htm,.pdf,.docx,text/plain,text/markdown,text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(event) => void uploadFile(event)}
                disabled={documentState.isMutating}
              />
              <small>TXT/Markdown up to 2 MB · HTML up to 1 MB · PDF up to 2 MB · DOCX up to 4 MB</small>
            </label>
            <label>
              <span>Status</span>
              <select
                className="settings-select"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as KnowledgeDocumentStatus | "")}
              >
                <option value="">All statuses</option>
                <option value="queued">Queued</option>
                <option value="parsing">Parsing</option>
                <option value="ready">Ready</option>
                <option value="failed">Failed</option>
              </select>
            </label>
            <label>
              <span>Origin</span>
              <select
                className="settings-select"
                value={originFilter}
                onChange={(event) => setOriginFilter(event.target.value as KnowledgeDocumentOrigin | "")}
              >
                <option value="">All origins</option>
                <option value="source">Uploaded sources</option>
                <option value="derived">Derived notes</option>
              </select>
            </label>
          </div>

          {(uploadError || documentError) && (
            <div className="settings-note settings-note--error" role="alert">
              {uploadError ?? documentError}
            </div>
          )}

          <div className="project-knowledge-library__documents">
            <div>
              {documentState.documents.length > 0 ? (
                <DataTable headers={["Document", "Format", "Origin", "Status", "Updated"]}>
                  {documentState.documents.map((document) => (
                    <tr
                      key={document.documentId}
                      className={selectedDocumentId === document.documentId ? "is-selected" : ""}
                    >
                      <td>
                        <button
                          type="button"
                          className="project-knowledge-library__document-button"
                          onClick={() => setDocumentSelection({
                            scopeKey: documentScopeKey,
                            documentId: document.documentId,
                          })}
                          aria-pressed={selectedDocumentId === document.documentId}
                        >
                          <strong>{document.title}</strong>
                          <span>{document.sourceName || "Inline source"}</span>
                        </button>
                      </td>
                      <td>{document.sourceFormat.toUpperCase()}</td>
                      <td>{document.origin}</td>
                      <td><StatusBadge tone={statusTone(document.status)}>{document.status}</StatusBadge></td>
                      <td>{formatDate(document.updatedAt)}</td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <EmptyState
                  title={documentState.isLoading ? "Loading documents…" : "No documents in this view"}
                  description={documentState.isLoading
                    ? "BrainRouter is loading the selected knowledge base."
                    : "Upload a source or change the status and origin filters."}
                />
              )}
            </div>

            <aside className="project-knowledge-library__status" aria-live="polite">
              <span>Processing status</span>
              {!selectedDocumentId && <p>Select a document to inspect its processing job.</p>}
              {selectedDocumentId && statusState.isLoading && <p>Loading status…</p>}
              {statusError && <p className="project-knowledge-library__error">{statusError}</p>}
              {statusState.document && (
                <>
                  <h3>{statusState.document.title}</h3>
                  <StatusBadge tone={statusTone(statusState.document.status)}>
                    {statusState.document.status}
                  </StatusBadge>
                  <dl>
                    <div><dt>Job</dt><dd>{statusState.document.processing.jobState}</dd></div>
                    <div><dt>Attempts</dt><dd>{statusState.document.processing.attempts}/{statusState.document.processing.maxAttempts}</dd></div>
                    <div><dt>Chunks</dt><dd>{statusState.document.processing.chunkCount}</dd></div>
                    <div><dt>Embeddings</dt><dd>{statusState.document.processing.embeddingCount}</dd></div>
                    <div><dt>Updated</dt><dd>{formatDate(statusState.document.updatedAt)}</dd></div>
                  </dl>
                  {statusState.document.statusMessage && <p>{statusState.document.statusMessage}</p>}
                  {statusState.document.status !== "ready" && statusState.document.processing.retryable && (
                    <PremiumButton
                      size="small"
                      variant="ghost"
                      disabled={statusState.isRetrying}
                      onClick={() => void statusState.retry().catch(() => {})}
                    >
                      {statusState.isRetrying ? "Retrying…" : "Retry processing"}
                    </PremiumButton>
                  )}
                </>
              )}
            </aside>
          </div>

          <div className="project-knowledge-library__search">
            <div className="knowledge-section-heading">
              <span>Search preview</span>
              <h2>Check what an agent can retrieve</h2>
              <p>Results stay inside the selected Project and knowledge base and include their source citation.</p>
            </div>
            <form onSubmit={(event) => void search(event)}>
              <input
                className="settings-input"
                value={searchQuery}
                maxLength={4000}
                placeholder="Ask about a decision, concept, or requirement"
                aria-label="Search Project knowledge"
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              <PremiumButton
                type="submit"
                variant="primary"
                disabled={!searchQuery.trim() || searchState.isSearching}
              >
                {searchState.isSearching ? "Searching…" : "Search"}
              </PremiumButton>
            </form>
            {searchError && (
              <div className="settings-note settings-note--error" role="alert">{searchError}</div>
            )}
            {searchState.result && (
              <div className="project-knowledge-library__results" aria-live="polite">
                <p>{searchState.result.hits.length} result{searchState.result.hits.length === 1 ? "" : "s"} · {searchState.result.mode} retrieval</p>
                {searchState.result.hits.map((hit) => (
                  <article key={hit.citation.chunkId}>
                    <p>{hit.content}</p>
                    <footer>
                      <strong>{hit.citation.documentTitle}</strong>
                      <span>{hit.citation.sourceName || "Project source"} · section {hit.citation.ordinal + 1}</span>
                      <span>{hit.matchedBy.join(" + ")} · {hit.score.toFixed(3)}</span>
                    </footer>
                  </article>
                ))}
                {searchState.result.hits.length === 0 && (
                  <EmptyState
                    title="No matching passages"
                    description="Try a different phrase or upload more source material to this base."
                  />
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
