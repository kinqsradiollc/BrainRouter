/**
 * ADR-030 Q4 — the whole parsed document, one addressable part at a time.
 *
 * The attachment detail shows `extractedText`, which is the BOUNDED extract the
 * model received. This shows what that extract is a piece of, and it is the only
 * place in the app where the two can be compared — which is the point: an answer
 * built on the first 20,000 characters of a 90-page contract looks exactly like
 * an answer built on the contract, until you can see how much was left out.
 *
 * **It parses nothing.** Q2 measured the parser at 4.6 MB of WebAssembly against
 * a 1,750,000-byte initial-JavaScript budget, so it runs in the Electron main
 * process and this asks over `attachment-document` / `attachment-document-part`.
 * The host does not parse either — the artifact was written when the file was
 * attached, so both queries are a JSON read.
 *
 * **Its own module, loaded lazily**, for the same budget: a reader that only
 * ever renders for a PDF has no business in the bytes every window pays for
 * before it draws anything. Q2's argument does not stop at the parser.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

/** The outline the host returns — ADR-030's `documentOutlineState`, flattened. */
export interface DocumentOutline {
  attachmentId: string;
  name: string;
  classification: string;
  pageCount?: number;
  partCount: number;
  notice: string;
  parts: Array<{ uri: string; index: number; page?: number; kind?: string; chars: number; preview: string }>;
  omittedLabel?: string;
}

export interface DocumentPart {
  attachmentId: string;
  index: number;
  partCount: number;
  page?: number;
  kind?: string;
  text: string;
  truncated?: boolean;
}

/**
 * Parts are fetched one at a time rather than all at once. The outline costs a
 * line per part; the whole document does not belong on the bridge to render one
 * page of it — which is the same argument the reference resolver makes for the
 * agent, one process over.
 */
export function DocumentReader({ attachmentId }: { attachmentId: string }): React.ReactElement | null {
  const [outline, setOutline] = useState<DocumentOutline | null>(null);
  const [part, setPart] = useState<DocumentPart | null>(null);
  const [asked, setAsked] = useState(false);
  const nsRef = useRef(`doc${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    const ns = nsRef.current;
    const off = window.brainrouter.onEvent((msg) => {
      const e = msg.event as { kind: string; id?: string; ok?: boolean; result?: unknown };
      if (e.kind !== 'query-result' || !e.id?.startsWith(ns)) return;
      if (e.id === `${ns}:outline`) {
        setAsked(true);
        setOutline((e.ok && e.result ? e.result : null) as DocumentOutline | null);
        return;
      }
      if (e.id.startsWith(`${ns}:part:`)) setPart((e.ok && e.result ? e.result : null) as DocumentPart | null);
    });
    setOutline(null);
    setPart(null);
    setAsked(false);
    window.brainrouter.send({
      kind: 'query', id: `${ns}:outline`, name: 'attachment-document', args: { id: attachmentId },
    });
    return off;
  }, [attachmentId]);

  const openPart = useCallback((index: number) => {
    setPart(null);
    window.brainrouter.send({
      kind: 'query', id: `${nsRef.current}:part:${index}`,
      name: 'attachment-document-part', args: { id: attachmentId, part: index },
    });
  }, [attachmentId]);

  if (!asked) return null;
  if (!outline) {
    // Said rather than hidden: "there is no parsed document" and "the document
    // is empty" are different facts, and merging them is the failure this ADR is
    // about, one surface over.
    return <div className="sched-note">No parsed document for this attachment.</div>;
  }

  return (
    <>
      <div className="tasks-section">
        <span>
          Parsed document · {outline.classification}
          {outline.pageCount ? ` · ${outline.pageCount} page${outline.pageCount === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      {/* D3's sentence, in our voice — the one that says a scan is a scan. */}
      {outline.notice ? <div className="req-desc">{outline.notice}</div> : null}
      <div className="req-desc" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {outline.parts.map((p) => (
          <button
            key={p.index}
            className={`pc-tag${part?.index === p.index ? ' active' : ''}`}
            title={p.preview || (p.kind && p.kind !== 'text' ? `${p.kind} — no text layer` : '')}
            onClick={() => openPart(p.index)}
          >
            {p.page !== undefined ? `p${p.page}` : `#${p.index}`}
            {p.kind && p.kind !== 'text' ? ' ⚠' : ''}
          </button>
        ))}
      </div>
      {outline.omittedLabel ? <div className="sched-note">{outline.omittedLabel}</div> : null}
      {part ? (
        <pre className="annot-quote art-source" style={{ maxHeight: 320, overflow: 'auto' }}>
          {part.text || `(${part.kind === 'scanned' ? 'a scan' : 'no text'} — nothing was extracted from this page)`}
        </pre>
      ) : null}
    </>
  );
}
