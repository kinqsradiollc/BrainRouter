import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  computeReviewChunks,
  applyReview,
  reviewStats,
  type ReviewChunk,
  type ReviewDecision,
} from '@kinqs/brainrouter-core/dist/write/writeDiff.js';

/**
 * WRITE MODE (§2 W1 + W3) — a Markdown writing workspace: a file tree of the
 * workspace's prose files, an editor, and a live Markdown preview (edit / split /
 * preview), with save + HTML export. Self-contained via a promise-wrapped host
 * query.
 *
 * §2 W3 — selection-driven inline AI: select prose → Polish / Rewrite / Continue
 * → the host rewrites it (one-shot, read-only model call) → the change lands as a
 * red/green per-chunk diff review (the W2 `writeDiff` primitive) you accept or
 * reject, hunk by hunk, before it replaces the selection. The editor is a textarea
 * for this slice; a CodeMirror editor with inline decorations layers on top.
 */

const WRITABLE = /\.(md|markdown|mdx|txt|text)$/i;

/** Promise-wrapped host query over the existing send/onEvent bridge (matches by id). */
function hostQuery<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T | null> {
  return new Promise((resolve) => {
    const br = (window as unknown as { brainrouter?: { send?: (c: unknown) => void; onEvent?: (l: (m: unknown) => void) => () => void } }).brainrouter;
    if (!br?.send || !br?.onEvent) { resolve(null); return; }
    const id = `wq_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let settled = false;
    const off = br.onEvent((msg: unknown) => {
      // Events are wrapped in an envelope: { seq, ts, sessionKey, event, workspaceRoot }.
      const ev = (msg as { event?: { kind?: string; id?: string; ok?: boolean; result?: unknown } })?.event;
      if (ev?.kind === 'query-result' && ev.id === id) {
        settled = true;
        off();
        resolve(ev.ok ? (ev.result as T) : null);
      }
    });
    br.send({ kind: 'query', id, name, args: args ?? {} });
    // inline-AI may take a while — give it room before falling back.
    setTimeout(() => { if (!settled) { off(); resolve(null); } }, 60000);
  });
}

type ViewMode = 'edit' | 'split' | 'preview';
type InlineAction = 'polish' | 'rewrite' | 'continue';

interface ReviewSession {
  chunks: ReviewChunk[];
  decisions: Record<number, ReviewDecision>;
  /** The selection range in `content` this review will replace on apply. */
  range: { start: number; end: number };
  action: InlineAction;
}

const ACTION_LABEL: Record<InlineAction, string> = { polish: 'Polish', rewrite: 'Rewrite', continue: 'Continue' };

// §2 W6 — one print-styled stylesheet shared by every export target.
const EXPORT_CSS = 'body{font:16px/1.65 -apple-system,system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.25rem;color:#1a1a1a}pre{background:#f4f4f5;padding:1rem;border-radius:8px;overflow:auto}code{font-family:ui-monospace,monospace;background:#f4f4f5;padding:.15em .35em;border-radius:4px}pre code{padding:0;background:none}blockquote{border-left:3px solid #ddd;margin:0;padding-left:1rem;color:#555}table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:.4em .7em}img{max-width:100%}@media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#e4e4e7}pre,code{background:#27272a}}';

/** Render the Markdown body to HTML (GFM: tables, strikethrough, task lists). */
function renderBody(content: string): string {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, content));
}

/**
 * Wrap a rendered body in a self-contained HTML document. `word: true` adds the
 * Office namespaces + WordDocument block so a `.doc` file opens directly in Word
 * (the classic dependency-free DOC export — true OOXML .docx via a converter
 * layers on top).
 */
function htmlDoc(title: string, body: string, opts?: { word?: boolean }): string {
  const ns = opts?.word ? ' xmlns:o="urn:schemas-microsoft-office:office" xmlns:w="urn:schemas-microsoft-office:word"' : '';
  const wordMeta = opts?.word ? '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->' : '';
  return `<!doctype html>
<html lang="en"${ns}><head><meta charset="utf-8">${wordMeta}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>${EXPORT_CSS}</style>
</head><body>${body}</body></html>`;
}

export function WritePanel(): React.ReactElement {
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(''); // last-saved content, for the dirty check
  const [view, setView] = useState<ViewMode>('split');
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState('');

  const taRef = useRef<HTMLTextAreaElement>(null);
  const [hasSel, setHasSel] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [review, setReview] = useState<ReviewSession | null>(null);

  const dirty = content !== loaded;

  const refreshFiles = useCallback(async () => {
    const res = await hostQuery<{ files?: Array<string | { path?: string }> }>('list-files', { limit: 3000 });
    const paths = (res?.files ?? [])
      .map((f) => (typeof f === 'string' ? f : f.path ?? ''))
      .filter((p) => p && WRITABLE.test(p))
      .sort((a, b) => a.localeCompare(b));
    setFiles(paths);
  }, []);

  useEffect(() => { void refreshFiles(); }, [refreshFiles]);

  const openFile = useCallback(async (p: string) => {
    setPath(p);
    setReview(null);
    setStatus('Loading…');
    const res = await hostQuery<{ content?: string; error?: string; binary?: boolean }>('file-read', { path: p });
    if (!res || res.error || res.binary) {
      setContent('');
      setLoaded('');
      setStatus(res?.error ? `Could not open: ${res.error}` : 'Could not open this file.');
      return;
    }
    setContent(res.content ?? '');
    setLoaded(res.content ?? '');
    setStatus('');
  }, []);

  const save = useCallback(async () => {
    if (!path) return;
    setStatus('Saving…');
    const res = await hostQuery<{ ok?: boolean; error?: string }>('write-save', { path, content });
    if (res?.ok) {
      setLoaded(content);
      setStatus('Saved.');
      void refreshFiles();
    } else {
      setStatus(`Save failed${res?.error ? `: ${res.error}` : ''}.`);
    }
  }, [path, content, refreshFiles]);

  // §2 W6 — export the current Markdown to a self-contained file next to the
  // source. Client-side render — no new deps.
  const exportAs = useCallback(async (kind: 'html' | 'doc') => {
    if (!path) return;
    setStatus('Exporting…');
    const title = path.split('/').pop() ?? 'document';
    const doc = htmlDoc(title, renderBody(content), { word: kind === 'doc' });
    const outPath = `${path.replace(/\.[^/.]+$/, '')}.${kind}`;
    const res = await hostQuery<{ ok?: boolean; error?: string }>('write-save', { path: outPath, content: doc });
    setStatus(res?.ok ? `Exported to ${outPath}` : `Export failed${res?.error ? `: ${res.error}` : ''}.`);
    void refreshFiles();
  }, [path, content, refreshFiles]);

  // §2 W6 — copy the rendered document to the clipboard as rich text, so pasting
  // into Word / Google Docs / email keeps the formatting (plain-text fallback).
  const copyRich = useCallback(async () => {
    if (!path) return;
    const html = htmlDoc(path.split('/').pop() ?? 'document', renderBody(content));
    try {
      const clip = navigator.clipboard as Clipboard & { write?: (items: ClipboardItem[]) => Promise<void> };
      if (typeof ClipboardItem !== 'undefined' && clip.write) {
        await clip.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([content], { type: 'text/plain' }),
        })]);
        setStatus('Copied as rich text.');
        return;
      }
      await navigator.clipboard.writeText(content);
      setStatus('Copied as plain text (rich text unavailable here).');
    } catch {
      setStatus('Copy failed — the clipboard is unavailable.');
    }
  }, [path, content]);

  // §2 W3 — run the selection through the inline assistant, then open a diff review.
  const runInline = useCallback(async (action: InlineAction) => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const text = content.slice(start, end);
    if (!text.trim()) { setStatus('Select some text first.'); return; }
    setAiBusy(true);
    setStatus(`${ACTION_LABEL[action]}…`);
    const res = await hostQuery<{ text?: string; error?: string }>('write-inline-ai', { action, text, doc: content });
    setAiBusy(false);
    if (!res || res.error || typeof res.text !== 'string') {
      setStatus(res?.error ? `Inline AI: ${res.error}` : 'Inline AI is unavailable (is a model configured?).');
      return;
    }
    const revised = res.text;
    if (revised === text) { setStatus('No change suggested.'); return; }
    const chunks = computeReviewChunks(text, revised);
    setReview({ chunks, decisions: {}, range: { start, end }, action });
    setStatus('');
  }, [content]);

  const setDecision = useCallback((id: number, decision: ReviewDecision) => {
    setReview((r) => (r ? { ...r, decisions: { ...r.decisions, [id]: decision } } : r));
  }, []);
  const setAllDecisions = useCallback((decision: ReviewDecision) => {
    setReview((r) => {
      if (!r) return r;
      const decisions: Record<number, ReviewDecision> = {};
      for (const c of r.chunks) if (c.op !== 'equal') decisions[c.id] = decision;
      return { ...r, decisions };
    });
  }, []);

  const applyReviewToDoc = useCallback(() => {
    setReview((r) => {
      if (!r) return null;
      const result = applyReview(r.chunks, r.decisions, 'accept');
      setContent((c) => c.slice(0, r.range.start) + result + c.slice(r.range.end));
      setStatus(`Applied — ${ACTION_LABEL[r.action]}.`);
      return null;
    });
  }, []);

  // Cmd/Ctrl-S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const visibleFiles = useMemo(
    () => (filter ? files.filter((f) => f.toLowerCase().includes(filter.toLowerCase())) : files),
    [files, filter],
  );

  const showAiBar = !!path && view !== 'preview' && !review;

  return (
    <div className="write-panel">
      <div className="write-tree">
        <input className="filter" placeholder="filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="write-files scroll">
          {visibleFiles.length === 0 ? <div className="empty">No Markdown/text files.</div> : visibleFiles.map((f) => (
            <button key={f} className={`write-file-row${f === path ? ' active' : ''}`} onClick={() => void openFile(f)} title={f}>
              {f.split('/').pop()}
              <span className="write-file-dir">{f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="write-main">
        <div className="write-bar">
          <span className="write-path">{path ? `${path}${dirty ? ' •' : ''}` : 'Select a file to write'}</span>
          <div className="write-bar-right">
            {(['edit', 'split', 'preview'] as ViewMode[]).map((m) => (
              <button key={m} className={`seg-toggle${view === m ? ' active' : ''}`} onClick={() => setView(m)}>{m}</button>
            ))}
            <button className="sched-add-btn" disabled={!path || !dirty} onClick={() => void save()}>Save</button>
            <button className="seg-toggle" disabled={!path} onClick={() => void exportAs('html')} title="Export as a self-contained HTML file">HTML</button>
            <button className="seg-toggle" disabled={!path} onClick={() => void exportAs('doc')} title="Export as a Word-openable .doc file">DOC</button>
            <button className="seg-toggle" disabled={!path} onClick={() => void copyRich()} title="Copy the formatted document — paste into Word, Docs, or email">Copy rich</button>
          </div>
        </div>

        {showAiBar ? (
          <div className="write-ai-bar">
            <span className="write-ai-label">✦ Selection AI</span>
            <div className="write-ai-actions">
              {(['polish', 'rewrite', 'continue'] as InlineAction[]).map((act) => (
                <button key={act} className="seg-toggle" disabled={aiBusy || !hasSel} onClick={() => void runInline(act)}>
                  {aiBusy ? '…' : ACTION_LABEL[act]}
                </button>
              ))}
            </div>
            <span className="write-ai-hint">{hasSel ? 'Reviews as an accept/reject diff' : 'Select text to enable'}</span>
          </div>
        ) : null}

        <div className={`write-body view-${view}`}>
          {view !== 'preview' ? (
            <textarea
              ref={taRef}
              className="write-editor"
              value={content}
              spellCheck
              placeholder={path ? '' : 'Open a file from the list to start writing.'}
              onChange={(e) => setContent(e.target.value)}
              onSelect={(e) => { const t = e.currentTarget; setHasSel(t.selectionEnd > t.selectionStart); }}
              disabled={!path}
            />
          ) : null}
          {view !== 'edit' ? (
            <div className="write-preview scroll">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || '_Nothing to preview yet._'}</ReactMarkdown>
            </div>
          ) : null}

          {review ? <ReviewOverlay review={review} onDecision={setDecision} onAll={setAllDecisions} onApply={applyReviewToDoc} onCancel={() => setReview(null)} /> : null}
        </div>

        {status ? <div className="write-status">{status}</div> : null}
      </div>
    </div>
  );
}

function ReviewOverlay({ review, onDecision, onAll, onApply, onCancel }: {
  review: ReviewSession;
  onDecision: (id: number, d: ReviewDecision) => void;
  onAll: (d: ReviewDecision) => void;
  onApply: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const stats = reviewStats(review.chunks);
  return (
    <div className="wai-overlay">
      <div className="wai-head">
        <span className="wai-title">Review · {ACTION_LABEL[review.action]}</span>
        <span className="wai-stats">
          {stats.added ? <span className="wai-stat-add">+{stats.added}</span> : null}
          {stats.removed ? <span className="wai-stat-del">−{stats.removed}</span> : null}
          {stats.changed ? <span className="wai-stat-rep">~{stats.changed}</span> : null}
          {stats.hunks === 0 ? <span className="wai-stat-add">no changes</span> : null}
        </span>
        <span className="wai-head-actions">
          <button className="seg-toggle" onClick={() => onAll('accept')}>Accept all</button>
          <button className="seg-toggle" onClick={() => onAll('reject')}>Reject all</button>
        </span>
      </div>

      <div className="wai-chunks scroll">
        {review.chunks.map((c) => {
          if (c.op === 'equal') {
            return c.original ? <pre key={c.id} className="wai-chunk wai-eq">{c.original}</pre> : null;
          }
          const decision = review.decisions[c.id] ?? 'accept';
          return (
            <div key={c.id} className={`wai-chunk wai-change wai-${decision}`}>
              <div className="wai-diff">
                {c.original ? <pre className="wai-del">{c.original}</pre> : null}
                {c.revised ? <pre className="wai-ins">{c.revised}</pre> : null}
              </div>
              <div className="wai-chunk-actions">
                <button className={`wai-toggle${decision === 'accept' ? ' on' : ''}`} onClick={() => onDecision(c.id, 'accept')} title="Accept this change">✓ accept</button>
                <button className={`wai-toggle${decision === 'reject' ? ' on' : ''}`} onClick={() => onDecision(c.id, 'reject')} title="Reject this change">✕ reject</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="wai-foot">
        <button className="seg-toggle" onClick={onCancel}>Cancel</button>
        <button className="sched-add-btn" onClick={onApply}>Apply to document</button>
      </div>
    </div>
  );
}
