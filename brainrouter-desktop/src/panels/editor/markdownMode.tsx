/**
 * Markdown mode for the Editor — the prose experience (live preview, the grounded
 * writing assistant, and ghost-text completion) that used to be the separate Docs
 * panel, now hosted INSIDE the code Editor for `.md`/`.markdown`/`.mdx` files. The
 * Editor owns the Monaco instance + content; these pieces render around it.
 *
 * Selection-AI + export live in EditorPanel itself (they need the editor ref +
 * the host save path); the heavier, self-contained UI lives here.
 */
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { hostQuery } from '../../lib/hostQuery.js';
import { isExternalHref, resolveDocHref } from '../../lib/docs/docLinks.js';
import { MARKDOWN_FILE } from '../../lib/docs/markdownExport.js';

// ── Ghost-text inline completion (W4), scoped to the active Markdown model so it
// never ghosts in a code file. Registered once on the global `markdown` language.
let ghostRegistered = false;
let activeMarkdownUri: string | null = null;
export function setActiveMarkdownModel(uri: string | null): void { activeMarkdownUri = uri; }

export function registerMarkdownGhost(monaco: Parameters<OnMount>[1]): void {
  if (ghostRegistered) return;
  ghostRegistered = true;
  const provider: Monaco.languages.InlineCompletionsProvider = {
    provideInlineCompletions: async (model, position, _ctx, token) => {
      if (model.uri.toString() !== activeMarkdownUri) return { items: [] };
      await new Promise((r) => setTimeout(r, 300)); // debounce typing bursts
      if (token.isCancellationRequested) return { items: [] };
      const prefix = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      if (prefix.trim().length < 3) return { items: [] };
      const res = await hostQuery<{ text?: string }>('write-ghost-complete', { prefix: prefix.slice(-2000) });
      if (token.isCancellationRequested || !res || typeof res.text !== 'string' || !res.text) return { items: [] };
      return { items: [{ insertText: res.text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
    },
    disposeInlineCompletions: () => { /* no per-result resources to free */ },
  };
  monaco.languages.registerInlineCompletionsProvider('markdown', provider);
}

/** Route a preview link: external → browser, doc → Editor, anchor → ignore. */
function onPreviewLink(
  e: React.MouseEvent, href: string | undefined, currentPath: string,
  onOpenFile?: (p: string) => void, onOpenUrl?: (u: string) => void,
): void {
  if (!href) return;
  e.preventDefault();
  if (href.startsWith('#')) return;
  if (isExternalHref(href)) { onOpenUrl?.(href); return; }
  const target = resolveDocHref(currentPath, href.split(/[?#]/)[0]);
  if (target) onOpenFile?.(target);
}

export function MarkdownPreview({ content, currentPath, onOpenFile, onOpenUrl }: {
  content: string; currentPath: string;
  onOpenFile?: (p: string) => void; onOpenUrl?: (u: string) => void;
}): React.ReactElement {
  const components = {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <a href={href} onClick={(e) => onPreviewLink(e, href, currentPath, onOpenFile, onOpenUrl)}>{children}</a>
    ),
  };
  return (
    <div className="editor-md-preview scroll">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content || '_Nothing to preview yet._'}</ReactMarkdown>
    </div>
  );
}

/** W5 — a workspace-grounded writing assistant in its own per-workspace thread. */
export function WritingAssistant({ currentPath, onOpenFile, onOpenUrl }: {
  currentPath: string | null;
  onOpenFile?: (p: string) => void; onOpenUrl?: (u: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [a, setA] = useState<{ text: string; grounded?: boolean; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async (): Promise<void> => {
    if (!q.trim()) return;
    setBusy(true); setA(null);
    const res = await hostQuery<{ text?: string; grounded?: boolean; error?: string }>('write-assistant', { question: q.trim(), currentPath });
    setBusy(false);
    setA(res && typeof res.text === 'string' ? { text: res.text, grounded: res.grounded, error: res.error } : { text: '', error: 'No response from the assistant.' });
  };
  const components = {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <a href={href} onClick={(e) => onPreviewLink(e, href, currentPath ?? '', onOpenFile, onOpenUrl)}>{children}</a>
    ),
  };
  return (
    <div className={`docs-asst${open ? ' open' : ''}`}>
      <button className="docs-asst-toggle" onClick={() => setOpen((o) => !o)} title="A workspace-grounded writing assistant in its own thread">
        <span className="docs-asst-title">✦ Writing assistant</span>
        <span className="docs-asst-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="docs-asst-body">
          <div className="docs-asst-row">
            <input
              className="toolbar-input docs-asst-input"
              placeholder="Ask about your docs — grounded in this workspace…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }}
            />
            <button className="btn primary" disabled={busy || !q.trim()} onClick={() => void ask()}>{busy ? '…' : 'Ask'}</button>
          </div>
          {a?.error ? <div className="mem-error">{a.error}</div> : null}
          {a && !a.error ? (
            <div className="docs-asst-answer">
              {a.grounded ? <span className="docs-asst-grounded" title="Answer used workspace documents">grounded</span> : null}
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{a.text || '_(no answer)_'}</ReactMarkdown>
            </div>
          ) : null}
          <div className="docs-asst-note">Separate per-workspace thread; grounds on your workspace docs (the brain's recall augments this when connected).</div>
        </div>
      ) : null}
    </div>
  );
}

// ── Selection AI (W3): Polish / Rewrite / Continue → a per-chunk accept/reject diff.
import { reviewStats, type ReviewChunk, type ReviewDecision } from '@kinqs/brainrouter-core/write';

export type InlineAction = 'polish' | 'rewrite' | 'continue';
export const ACTION_LABEL: Record<InlineAction, string> = { polish: 'Polish', rewrite: 'Rewrite', continue: 'Continue' };
export type MonacoRange = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
export interface ReviewSession {
  chunks: ReviewChunk[];
  decisions: Record<number, ReviewDecision>;
  range: MonacoRange;
  action: InlineAction;
}

export function ReviewOverlay({ review, onDecision, onAll, onApply, onCancel }: {
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
          if (c.op === 'equal') return c.original ? <pre key={c.id} className="wai-chunk wai-eq">{c.original}</pre> : null;
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
        <button className="btn primary" onClick={onApply}>Apply to document</button>
      </div>
    </div>
  );
}

export { MARKDOWN_FILE };
