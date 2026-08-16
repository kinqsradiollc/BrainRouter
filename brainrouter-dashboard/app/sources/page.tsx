'use client';

// 0.4.3 — Sources view. Surfaces the captured source layer (source_documents +
// source_chunks) that grounds recall provenance: turns / files / tool output
// are chunked, and every distilled memory cites the chunks it came from. Click
// a document to drill into its chunks (the same data `memory_fetch_source_chunk`
// returns to an agent).

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { SourceChunk } from '@kinqs/brainrouter-types';
import { AuthGuard } from '../../components/AuthGuard';
import { EmptyState } from '../../components/EmptyState';
import { KnowledgeScopePicker, useKnowledgeScope } from '../../components/KnowledgeScopePicker';
import { PageHeader } from '../../components/PageHeader';
import { PremiumButton } from '../../components/PremiumButton';
import { brainApi } from '../../lib/brainApi';
import { InlineLoading } from '../../components/LoadingSpinner';

function SourcesContent() {
  const scopeState = useKnowledgeScope();
  const docs = scopeState.sources;
  const scopeKey = `${scopeState.scope.orgId}\u0000${scopeState.scope.projectId}\u0000${scopeState.scope.workspaceTag}`;
  const [openId, setOpenId] = useState<string | null>(null);
  const [chunkState, setChunkState] = useState<{
    scopeKey: string;
    values: Record<string, SourceChunk[] | 'loading'>;
  }>({ scopeKey, values: {} });
  const chunkRequestIdRef = useRef(0);
  const chunkAbortRef = useRef<AbortController | null>(null);
  const activeScopeKeyRef = useRef(scopeKey);
  activeScopeKeyRef.current = scopeKey;
  const chunks = chunkState.scopeKey === scopeKey ? chunkState.values : {};
  // 0.4.3 — transcripts are auto-ingested every turn and dominate this view
  // ("transcript firehose"). Hide them by default so durable sources (files,
  // tool output, tree leaves) are foregrounded; one click reveals them. Old
  // transcripts are pruned via the memory_prune_sources tool.
  const [showTranscripts, setShowTranscripts] = useState(false);

  const scopedDocs = useMemo(
    () => docs.filter((d) => !scopeState.scope.workspaceTag || d.workspaceTag === scopeState.scope.workspaceTag),
    [docs, scopeState.scope.workspaceTag],
  );
  const transcriptCount = useMemo(() => scopedDocs.filter((d) => d.kind === 'transcript').length, [scopedDocs]);
  const visibleDocs = useMemo(
    () => scopedDocs.filter((d) => showTranscripts || d.kind !== 'transcript'),
    [scopedDocs, showTranscripts],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const requested = new URLSearchParams(window.location.search).get('source');
    if (requested) setOpenId(requested);
  }, []);

  useEffect(() => {
    chunkRequestIdRef.current += 1;
    chunkAbortRef.current?.abort();
    chunkAbortRef.current = null;
    setChunkState({ scopeKey, values: {} });
  }, [scopeKey]);

  useEffect(() => {
    if (!openId || !scopeState.scope.orgId || scopeState.loading || !scopedDocs.some((doc) => doc.id === openId))
      return;
    chunkRequestIdRef.current += 1;
    chunkAbortRef.current?.abort();
    const requestId = chunkRequestIdRef.current;
    const controller = new AbortController();
    chunkAbortRef.current = controller;
    const requestedId = openId;
    const requestedScopeKey = scopeKey;
    setChunkState({ scopeKey: requestedScopeKey, values: { [requestedId]: 'loading' } });
    void brainApi
      .sourceChunks(requestedId, scopeState.scope.orgId, controller.signal)
      .then((result) => {
        if (requestId !== chunkRequestIdRef.current || activeScopeKeyRef.current !== requestedScopeKey) return;
        setChunkState({ scopeKey: requestedScopeKey, values: { [requestedId]: result.chunks ?? [] } });
      })
      .catch((caught) => {
        if (
          requestId !== chunkRequestIdRef.current ||
          activeScopeKeyRef.current !== requestedScopeKey ||
          (caught instanceof Error && caught.name === 'AbortError')
        )
          return;
        setChunkState({ scopeKey: requestedScopeKey, values: { [requestedId]: [] } });
      });
    return () => {
      if (chunkAbortRef.current === controller) chunkAbortRef.current = null;
      chunkRequestIdRef.current += 1;
      controller.abort();
    };
  }, [openId, scopeKey, scopeState.loading, scopeState.scope.orgId, scopedDocs]);

  useEffect(() => {
    if (!openId || scopeState.loading) return;
    const target = scopedDocs.find((doc) => doc.id === openId);
    if (target?.kind === 'transcript') setShowTranscripts(true);
    if (target)
      requestAnimationFrame(() =>
        document.getElementById(`source-${openId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      );
  }, [openId, scopedDocs, scopeState.loading]);

  const toggle = (id: string) => {
    const next = openId === id ? null : id;
    setOpenId(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('source', next);
    else url.searchParams.delete('source');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const addSourceHref = useMemo(() => {
    const query = new URLSearchParams({ panel: 'connections' });
    if (scopeState.scope.orgId) query.set('orgId', scopeState.scope.orgId);
    if (scopeState.scope.projectId) query.set('projectId', scopeState.scope.projectId);
    return `/integrations?${query.toString()}`;
  }, [scopeState.scope.orgId, scopeState.scope.projectId]);
  const requestedSourceMissing = Boolean(openId && !scopeState.loading && !scopedDocs.some((doc) => doc.id === openId));

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}
    >
      <PageHeader
        title="Connected sources"
        description="See the documents and conversations BrainRouter can use, and open any source to review the material it contains."
      >
        <Link href={addSourceHref}>
          <PremiumButton variant="primary">Add a source</PremiumButton>
        </Link>
      </PageHeader>
      <KnowledgeScopePicker state={scopeState} />

      {scopeState.error && (
        <p style={{ color: '#E5675F', fontSize: '13px' }}>Could not load sources: {scopeState.error}</p>
      )}
      {requestedSourceMissing && (
        <div className="settings-note settings-note--error">
          That source is not available in the selected organization, project, or workspace.
        </div>
      )}
      {scopeState.loading && !scopeState.error && (
        <InlineLoading label="Loading sources…" />
      )}
      {!scopeState.loading && scopedDocs.length === 0 && (
        <EmptyState
          title="No sources in this scope"
          description="Connect a repository, document service, or communication account to bring its material into this workspace."
        >
          <Link href={addSourceHref}>
            <PremiumButton variant="primary">Add a source</PremiumButton>
          </Link>
        </EmptyState>
      )}

      {transcriptCount > 0 && (
        <button
          type="button"
          onClick={() => setShowTranscripts((v) => !v)}
          style={{
            alignSelf: 'flex-start',
            background: 'none',
            border: '1px solid var(--color-golden-accent)',
            borderRadius: '6px',
            color: 'var(--color-golden-accent)',
            cursor: 'pointer',
            fontSize: '12px',
            letterSpacing: '0.04em',
            padding: '6px 12px',
          }}
        >
          {showTranscripts
            ? `Hide ${transcriptCount} conversation transcript${transcriptCount === 1 ? '' : 's'}`
            : `Show ${transcriptCount} hidden conversation transcript${transcriptCount === 1 ? '' : 's'}`}
        </button>
      )}
      {scopedDocs.length > 0 && visibleDocs.length === 0 && (
        <p style={{ color: 'var(--color-stone-text)', fontSize: '13px' }}>
          All {transcriptCount} source{transcriptCount === 1 ? '' : 's'} {transcriptCount === 1 ? 'is' : 'are'}{' '}
          conversation transcript{transcriptCount === 1 ? '' : 's'} (hidden). Use the toggle above to view them, or
          prune old ones with <code>memory_prune_sources</code>.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {visibleDocs.map((d) => {
          const open = openId === d.id;
          const loaded = chunks[d.id];
          return (
            <div
              id={`source-${d.id}`}
              key={d.id}
              className="card-premium"
              style={{ display: 'flex', flexDirection: 'column', gap: '10px', scrollMarginTop: '24px' }}
            >
              <button
                onClick={() => toggle(d.id)}
                aria-expanded={open}
                aria-controls={`source-chunks-${d.id}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '12px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  padding: 0,
                  width: '100%',
                }}
              >
                <span style={{ color: 'var(--color-white-frost)', fontWeight: 500, overflowWrap: 'anywhere' }}>
                  <span
                    style={{
                      color: 'var(--color-golden-accent)',
                      fontSize: '11px',
                      letterSpacing: '0.08em',
                      marginRight: '8px',
                    }}
                  >
                    {d.kind.toUpperCase()}
                  </span>
                  {d.title || d.uri || d.id}
                </span>
                <span style={{ color: 'var(--color-stone-text)', fontSize: '11px', whiteSpace: 'nowrap' }}>
                  {d.chunkCount} chunk{d.chunkCount === 1 ? '' : 's'} · {open ? '▾' : '▸'}
                </span>
              </button>

              {open && (
                <div id={`source-chunks-${d.id}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {(loaded === undefined || loaded === 'loading') && (
                    <InlineLoading label="Loading chunks…" />
                  )}
                  {Array.isArray(loaded) && loaded.length === 0 && (
                    <p style={{ color: 'var(--color-stone-text)', fontSize: '12px', margin: 0 }}>No chunks.</p>
                  )}
                  {Array.isArray(loaded) &&
                    loaded.map((c) => (
                      <div
                        key={c.id}
                        style={{ borderLeft: '2px solid var(--color-golden-accent)', paddingLeft: '10px' }}
                      >
                        <div style={{ color: 'var(--color-stone-text)', fontSize: '11px', marginBottom: '2px' }}>
                          #{c.ordinal}
                          {c.symbol ? ` · ${c.symbol}` : ''}
                          {c.filePath ? ` · ${c.filePath}` : ''}
                          {c.startLine != null ? ` · L${c.startLine}–${c.endLine ?? c.startLine}` : ''}
                          {` · ~${c.tokenCount} tok`}
                        </div>
                        <pre
                          style={{
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'anywhere',
                            fontSize: '12px',
                            color: 'var(--color-white-frost)',
                            margin: 0,
                            fontFamily: 'var(--font-mono, monospace)',
                          }}
                        >
                          {c.content.length > 600 ? `${c.content.slice(0, 600)}…` : c.content}
                        </pre>
                      </div>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

export default function SourcesPage() {
  return (
    <AuthGuard>
      <SourcesContent />
    </AuthGuard>
  );
}
