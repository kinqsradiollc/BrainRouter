/**
 * Session Attachments — a per-session viewer for every file you've attached to
 * the current chat (images, PDFs, text, code). Mirrors the CLI attachmentStore
 * over the existing host endpoints (`attachment-list` / `attachment-read`); no
 * parallel state. The panel owns its bridge round-trips directly (query ids
 * namespaced per mount), the same self-fetch pattern the Terminal panel uses.
 * Images preview inline via the host's size-capped data URI; text/PDF show the
 * extracted-text snippet the model actually receives.
 *
 * ADR-030 Q2/Q4 — a PDF also has a PARSED DOCUMENT, and `DocumentReader` shows
 * it. That component is loaded on demand rather than imported: it only ever
 * renders for a PDF, and the renderer's initial-JavaScript budget is the same
 * 1,750,000 bytes that decided the parser itself runs in the main process.
 */
import React, { Suspense, lazy, useEffect, useRef, useState, useCallback } from 'react';
import type { AttachmentRecord } from '@kinqs/brainrouter-types';

const DocumentReader = lazy(() => import('./DocumentReader.js').then((m) => ({ default: m.DocumentReader })));

type AttachmentReadResult = AttachmentRecord & { dataUri?: string };

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function kindLabel(kind: string): string {
  return kind === 'pdf' ? 'PDF' : kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function AttachmentsPanel({ scope = 'session', onSendToChat }: {
  /** 'session' (default) lists this chat's attachments; 'workspace' lists all. */
  scope?: 'session' | 'workspace';
  /** Reference an attachment back in the composer to keep working on it. */
  onSendToChat?: (text: string) => void;
}): React.ReactElement {
  const [records, setRecords] = useState<AttachmentRecord[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const nsRef = useRef(`att${Math.random().toString(36).slice(2, 8)}`);

  const refresh = useCallback(() => {
    setLoading(true);
    window.brainrouter.send({ kind: 'query', id: `${nsRef.current}:list`, name: 'attachment-list', args: { scope } });
  }, [scope]);

  useEffect(() => {
    const ns = nsRef.current;
    const off = window.brainrouter.onEvent((msg) => {
      const e = msg.event as { kind: string; id?: string; ok?: boolean; result?: unknown };
      if (e.kind !== 'query-result' || !e.id?.startsWith(ns)) return;
      if (e.id === `${ns}:list`) {
        setLoading(false);
        const list = Array.isArray(e.result) ? (e.result as AttachmentRecord[]) : [];
        setRecords(list);
        // Prefetch inline previews for image attachments (host caps at ~5MB).
        for (const rec of list) {
          if (rec.kind === 'image') {
            window.brainrouter.send({ kind: 'query', id: `${ns}:read:${rec.id}`, name: 'attachment-read', args: { id: rec.id } });
          }
        }
        return;
      }
      if (e.id.startsWith(`${ns}:read:`) && e.ok && e.result) {
        const rec = e.result as AttachmentReadResult;
        if (rec.dataUri) setPreviews((prev) => ({ ...prev, [rec.id]: rec.dataUri! }));
      }
    });
    refresh();
    return off;
  }, [refresh]);

  const selected = records.find((r) => r.id === selectedId) ?? records[0] ?? null;

  return (
    <div className="scroll art-panel attachments-panel">
      <div className="sched-add">
        <div className="annot-counts" style={{ justifyContent: 'space-between', width: '100%' }}>
          <span className="set-desc" style={{ margin: 0 }}>
            {scope === 'workspace' ? 'All attachments in this workspace' : 'Files attached to this chat'} · {records.length}
          </span>
          <button className="sched-add-btn" onClick={refresh}>Refresh</button>
        </div>
      </div>

      {loading && records.length === 0 ? (
        <div className="empty" style={{ padding: '10px 12px' }}>Loading attachments…</div>
      ) : records.length === 0 ? (
        <div className="empty artifact-empty">
          <span className="empty-title">No attachments{scope === 'session' ? ' in this chat' : ' yet'}</span>
          <span className="empty-note">Drop a file on the composer or use the attach button. Images, PDFs, text, and code appear here.</span>
        </div>
      ) : (
        <>
          {records.map((rec) => (
            <button key={rec.id} className={`req-row${selected?.id === rec.id ? ' active' : ''}`} onClick={() => setSelectedId(rec.id)}>
              {rec.kind === 'image' && previews[rec.id]
                ? <img src={previews[rec.id]} alt={rec.name} className="attachment-thumb" />
                : <span className="annot-kind" title={`kind: ${rec.kind}`}>{kindLabel(rec.kind)}</span>}
              <span className="req-title" title={rec.name}>{rec.name}</span>
              <span className="req-id">{formatBytes(rec.byteSize)}</span>
            </button>
          ))}
          {selected ? <AttachmentDetail rec={selected} preview={previews[selected.id]} onSendToChat={onSendToChat} /> : null}
        </>
      )}

      <div className="sched-note">Attachments persist in <code>.brainrouter/cli/attachments.json</code> — shared with the CLI. Image attachments are also sent to vision-capable models inline.</div>
    </div>
  );
}

function AttachmentDetail({ rec, preview, onSendToChat }: {
  rec: AttachmentRecord;
  preview?: string;
  onSendToChat?: (text: string) => void;
}): React.ReactElement {
  const meta: string[] = [
    kindLabel(rec.kind),
    rec.mimeType,
    formatBytes(rec.byteSize),
    rec.width && rec.height ? `${rec.width}×${rec.height}` : '',
    rec.pageCount ? `${rec.pageCount} page${rec.pageCount === 1 ? '' : 's'}` : '',
    rec.createdAt ? new Date(rec.createdAt).toLocaleString() : '',
  ].filter(Boolean);
  return (
    <div className="req-detail">
      <div className="req-detail-head">
        <span className="annot-kind">{kindLabel(rec.kind)}</span>
        <span className="req-detail-title" title={rec.name}>{rec.name}</span>
        <span className="req-id">{rec.id}</span>
      </div>
      <div className="req-desc" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {meta.map((m, i) => <span key={i} className="pc-tag">{m}</span>)}
      </div>
      {/* ADR-030 D3 — what the parse could NOT read, in the product's own voice.
          The record has carried this since ingest and nothing showed it, which
          made a scanned document look like a document with no text in it. */}
      {rec.extractionNotice ? <div className="req-desc">{rec.extractionNotice}</div> : null}

      {rec.kind === 'image' && preview ? (
        <div className="attachment-preview-img"><img src={preview} alt={rec.name} style={{ maxWidth: '100%', borderRadius: 8 }} /></div>
      ) : rec.extractedText ? (
        <div className="tasks-section"><span>Extracted text{rec.textTruncated ? ' (truncated)' : ''}</span></div>
      ) : null}
      {rec.kind !== 'image' && rec.extractedText ? (
        <pre className="annot-quote art-source" style={{ maxHeight: 320, overflow: 'auto' }}>{rec.extractedText}</pre>
      ) : null}
      {rec.kind === 'image' && !preview ? (
        <div className="empty">Preview unavailable (image over the inline size cap).</div>
      ) : null}

      {rec.kind === 'pdf' ? (
        <Suspense fallback={null}>
          <DocumentReader key={rec.id} attachmentId={rec.id} />
        </Suspense>
      ) : null}

      {onSendToChat ? (
        <div className="req-controls">
          <button className="btn" title="Reference this attachment in the composer"
            onClick={() => onSendToChat(`About the attached file "${rec.name}" (id: ${rec.id}):\n\n`)}>Reference in chat</button>
        </div>
      ) : null}

      {rec.storedPath ? <div className="annot-anchor-line">{rec.storedPath}</div> : null}
    </div>
  );
}
