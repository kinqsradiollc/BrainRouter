/**
 * ARTIFACT-RECORDS (0.4.15) — the Artifacts panel: per-workspace durable
 * records for a workflow output a chat produces or reviews (design note,
 * sketch, HTML prototype, markdown report, verification summary, review
 * export). Lists this workspace's artifacts (filterable by kind + status),
 * shows a selected artifact's detail (kind / format / path / summary /
 * requirement link / memory count) plus a Preview area that renders markdown
 * through the app's chat markdown renderer, renders HTML in an inert sandboxed
 * iframe, and lets you change an artifact's lifecycle status. Pure view logic
 * lives in lib/artifacts/artifactsView. Wraps the CLI artifactStore over the
 * host endpoints — no parallel state.
 */
import React, { useEffect, useState } from 'react';
import type { ArtifactRecord, ArtifactKind, ArtifactStatus, AnnotationRecord } from '@kinqs/brainrouter-types';
import remarkGfm from 'remark-gfm';
import { inlinePlaceholders } from '@kinqs/brainrouter-core/prototype/placeholders';
import { Markdown, MD_COMPONENTS } from '../../chat/markdown.js';
import { Button } from '../../components/primitives/Button.js';
import { Chip } from '../../components/primitives/Badge.js';
import {
  sortArtifacts, artifactCounts, kindLabel, statusClass, isReactArtifact,
  initialSessionScope, filterBySession, showsSessionProvenance, toggleSession, sessionsIn,
  type SessionScope,
  ARTIFACT_KIND_OPTIONS, ARTIFACT_STATUS_OPTIONS,
} from '../../lib/artifacts/artifactsView.js';

const KIND_FILTER: Array<'' | ArtifactKind> = ['', ...ARTIFACT_KIND_OPTIONS];
const STATUS_FILTER: Array<'' | ArtifactStatus> = ['', ...ARTIFACT_STATUS_OPTIONS];

export function ArtifactsPanel({ artifacts, annotations, currentSessionKey, sessionTitles, onCreate, onSetStatus, onPreview, onSave, onRevert, onSendToChat, onAnnotate }: {
  artifacts: ArtifactRecord[];
  /** ADR-028 B2 — the session the panel opens scoped to. */
  currentSessionKey?: string | null;
  /** Session key → a human label, for the scope control and provenance chips. */
  sessionTitles?: Record<string, string | undefined>;
  /** All workspace annotations — the detail filters to the selected artifact by targetId. */
  annotations?: AnnotationRecord[];
  onCreate?: (title: string) => void;
  onSetStatus: (id: string, status: ArtifactStatus) => void;
  /** Resolve the artifact's content (file via the safe workspace read, or inline). */
  onPreview: (a: ArtifactRecord) => void;
  /** §12 write-workspace — persist edited content (file-backed write or inline update). */
  onSave?: (id: string, content: string) => void;
  /** §AV-1 — restore a prior version's content as a new version. */
  onRevert?: (id: string, version: number) => void;
  /** §AV-5 — push the artifact into the chat composer to keep iterating on it. */
  onSendToChat?: (text: string) => void;
  /** §8 — capture an annotation anchored to this artifact. */
  onAnnotate?: (a: ArtifactRecord, body: string, block?: string) => void;
}): React.ReactElement {
  const [kindFilter, setKindFilter] = useState<'' | ArtifactKind>('');
  const [statusFilter, setStatusFilter] = useState<'' | ArtifactStatus>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  // ADR-028 B2 — start scoped to this session, widen deliberately. Opening onto
  // everything ever produced hands you a search problem you did not ask for.
  const [sessionScope, setSessionScope] = useState<SessionScope>(() => initialSessionScope(currentSessionKey));
  // Following the session is the point: switching sessions with the panel open
  // should show THAT session, not keep you pinned to where you started.
  useEffect(() => { setSessionScope(initialSessionScope(currentSessionKey)); }, [currentSessionKey]);

  // F1/F2 — honor a "focus this artifact" signal from the chat (auto-open on
  // artifact_write, or an inline card's Open button). The target id is stashed in
  // localStorage so a panel that mounts AFTER the signal (the auto-open case)
  // still picks it up on first render; the event re-selects while already open.
  useEffect(() => {
    const focus = (): void => {
      try {
        const raw = localStorage.getItem('br-artifact-focus');
        if (!raw) return;
        const parsed = JSON.parse(raw) as { id?: string; at?: number };
        if (parsed.id && (!parsed.at || Date.now() - parsed.at < 8000)) setSelectedId(parsed.id);
      } catch { /* ignore */ }
    };
    focus();
    window.addEventListener('br-artifact-focus', focus);
    return () => window.removeEventListener('br-artifact-focus', focus);
  }, []);

  const allSessions = sessionsIn(artifacts);
  const inScope = filterBySession(artifacts, sessionScope);
  const filtered = inScope.filter((a) =>
    (!kindFilter || a.kind === kindFilter) && (!statusFilter || a.status === statusFilter));
  const sorted = sortArtifacts(filtered);
  const counts = artifactCounts(inScope);
  // With more than one session in view, every row has to say where it came
  // from — an aggregated list without provenance is the same misattribution the
  // stale-panel bug caused, only on purpose.
  const showProvenance = showsSessionProvenance(sessionScope);
  const sessionLabel = (key: string): string => sessionTitles?.[key]?.slice(0, 28) || key.slice(0, 8);
  // Keep a valid selection: the first row, unless the user picked one still in view.
  const selected = sorted.find((a) => a.id === selectedId) ?? sorted[0] ?? null;

  const submitCreate = (): void => {
    if (!onCreate || !title.trim()) return;
    onCreate(title.trim());
    setTitle('');
  };

  return (
    <div className="scroll art-panel">
      <div className="sched-add">
        {onCreate ? (
          <div className="sched-add-row">
            <input className="filter" placeholder="new artifact title" value={title} onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitCreate(); }} />
            <button className="sched-add-btn" onClick={submitCreate}>Add</button>
          </div>
        ) : null}
        <div className="annot-filters">
          <label className="req-select">
            <span>Kind</span>
            <select className="filter" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as '' | ArtifactKind)}>
              {KIND_FILTER.map((k) => <option key={k || 'all'} value={k}>{k || 'all'}</option>)}
            </select>
          </label>
          <label className="req-select">
            <span>Status</span>
            <select className="filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | ArtifactStatus)}>
              {STATUS_FILTER.map((s) => <option key={s || 'all'} value={s}>{s || 'all'}</option>)}
            </select>
          </label>
        </div>
        {allSessions.length > 1 ? (
          <div className="annot-filters art-scope">
            <span className="art-scope-label">Sessions</span>
            {allSessions.map((key) => {
              const on = !sessionScope || sessionScope.has(key);
              return (
                <button key={key} type="button"
                  className={`art-scope-chip${on ? ' on' : ''}`}
                  title={sessionTitles?.[key] || key}
                  onClick={() => setSessionScope((s) => toggleSession(s, key, allSessions))}>
                  {key === currentSessionKey ? 'this session' : sessionLabel(key)}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="annot-counts">
          <Chip>{counts.draft} draft</Chip>
          <Chip>{counts.final} final</Chip>
          <Chip>{counts.archived} archived</Chip>
          <Chip>{counts.total} total</Chip>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="empty artifact-empty">
          <span className="empty-title">No artifacts{kindFilter || statusFilter ? ' match this filter' : (sessionScope && allSessions.length > 1 ? ' in the selected session(s)' : ' yet')}</span>
          <span className="empty-note">Design notes, reports, review exports, and verification summaries appear here.</span>
        </div>
      ) : (
        <>
          {sorted.map((a) => (
            <button key={a.id} className={`req-row${selected?.id === a.id ? ' active' : ''}`} onClick={() => setSelectedId(a.id)}>
              <span className="annot-kind" title={`kind: ${a.kind}`}>{a.kind}</span>
              <span className={`req-status ${statusClass(a.status)}`}>{a.status}</span>
              <span className="req-title">{a.title}</span>
              <span className="art-format" title={`format: ${a.format}`}>{a.format}</span>
              {showProvenance && a.sessionKey ? (
                <span className="art-provenance" title={sessionTitles?.[a.sessionKey] || a.sessionKey}>
                  {a.sessionKey === currentSessionKey ? 'this session' : sessionLabel(a.sessionKey)}
                </span>
              ) : null}
              <span className="req-id">{a.id}</span>
            </button>
          ))}

          {selected ? <ArtifactDetail art={selected} onSetStatus={onSetStatus} onPreview={onPreview} onSave={onSave} onRevert={onRevert} onSendToChat={onSendToChat} onAnnotate={onAnnotate}
            annotations={(annotations ?? []).filter((n) => n.targetId === selected.id)} /> : null}
        </>
      )}

      <div className="sched-note">Artifacts persist in <code>.brainrouter/cli/artifacts.json</code> — shared with the CLI. Preview renders markdown inline and HTML in a sandboxed frame.</div>
    </div>
  );
}

function ArtifactDetail({ art, annotations, onSetStatus, onPreview, onSave, onRevert, onSendToChat, onAnnotate }: {
  art: ArtifactRecord;
  annotations: AnnotationRecord[];
  onSetStatus: (id: string, status: ArtifactStatus) => void;
  onPreview: (a: ArtifactRecord) => void;
  onSave?: (id: string, content: string) => void;
  onRevert?: (id: string, version: number) => void;
  onSendToChat?: (text: string) => void;
  onAnnotate?: (a: ArtifactRecord, body: string, block?: string) => void;
}): React.ReactElement {
  // Re-resolve the content whenever the selected artifact changes — a file-backed
  // artifact's content lives on disk, fetched through the host's safe read.
  useEffect(() => { onPreview(art); }, [art.id, art.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // §AV-1 — version history. `viewVersion` lets the user browse a prior snapshot
  // (read-only) without changing the artifact; null = the live/current content.
  const versions = art.versions ?? [];
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  useEffect(() => { setViewVersion(null); }, [art.id]);
  const snapshot = viewVersion != null ? versions.find((v) => v.v === viewVersion) : undefined;
  const viewingOld = !!snapshot && snapshot.v !== art.currentVersion;
  // When browsing an old inline snapshot, show its content; otherwise the live content.
  const content = viewingOld ? (snapshot.content ?? '') : (art.content ?? '');
  // §12 write-workspace — an Edit toggle swaps the preview for an editable buffer.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  // Reset the draft whenever the resolved content changes (artifact switch / re-read).
  useEffect(() => { setDraft(content); setEditing(false); }, [art.id, content]);
  const [note, setNote] = useState('');
  const submitNote = (): void => {
    if (!onAnnotate || !note.trim()) return;
    onAnnotate(art, note.trim());
    setNote('');
  };
  return (
    <div className="req-detail">
      <div className="req-detail-head">
        <span className="annot-kind">{kindLabel(art.kind)}</span>
        <span className="req-detail-title">{art.title}</span>
        <span className="req-id">{art.id}</span>
      </div>

      {art.summary ? <div className="req-desc">{art.summary}</div> : null}

      <div className="req-controls">
        <label className="req-select">
          <span>Status</span>
          <select className="filter" value={art.status} onChange={(e) => onSetStatus(art.id, e.target.value as ArtifactStatus)}>
            {ARTIFACT_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <Chip>format: {art.format}</Chip>
        {versions.length > 1 ? (
          <label className="req-select">
            <span>Version</span>
            <select className="filter" value={viewVersion ?? art.currentVersion ?? versions.length}
              onChange={(e) => setViewVersion(Number(e.target.value))} title="Browse a prior snapshot (read-only)">
              {versions.map((v) => (
                <option key={v.v} value={v.v}>v{v.v}{v.v === art.currentVersion ? ' (current)' : ''} · {v.editedBy}</option>
              ))}
            </select>
          </label>
        ) : null}
        {viewingOld && onRevert ? (
          <Button variant="primary" title={`Restore the content of v${snapshot!.v} as a new version`}
            onClick={() => { onRevert(art.id, snapshot!.v); setViewVersion(null); }}>Restore v{snapshot!.v}</Button>
        ) : null}
        {onSendToChat ? (
          <Button title="Continue iterating on this artifact in the chat composer"
            onClick={() => onSendToChat(`Continue working on artifact ${art.id} ("${art.title}", ${art.format}). Current content:\n\n${content}`)}>Send to chat</Button>
        ) : null}
      </div>

      {art.path ? <div className="annot-anchor-line">{art.path}</div> : null}

      <div className="tasks-section">
        <span>{viewingOld ? `Preview · v${snapshot!.v} (read-only)` : editing ? 'Edit' : 'Preview'}</span>
        {!viewingOld && onSave ? (
          editing ? (
            <span className="art-edit-actions">
              <Button onClick={() => { setDraft(content); setEditing(false); }}>Cancel</Button>
              <Button variant="primary" onClick={() => { onSave(art.id, draft); setEditing(false); }}>Save{art.path ? ' to file' : ''}</Button>
            </span>
          ) : (
            <Button title={art.path ? `Edit and write back to ${art.path}` : 'Edit the artifact content'} onClick={() => { setDraft(content); setEditing(true); }}>Edit</Button>
          )
        ) : null}
      </div>
      {editing
        ? <textarea className="art-edit" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        : <ArtifactPreview art={art} content={content} />}

      {onAnnotate ? (
        <>
          <div className="tasks-section"><span>Annotations{annotations.length ? ` (${annotations.length})` : ''}</span></div>
          {annotations.length ? (
            <ul className="annot-thread">
              {annotations.map((n) => (
                <li key={n.id} className="annot-comment">
                  <div className="annot-comment-meta">
                    <span className={`req-status ${statusClass(n.status as ArtifactStatus)}`}>{n.status}</span>
                    {n.severity ? <span className="dim">{n.severity}</span> : null}
                    <span className="req-id">{n.id}</span>
                  </div>
                  <div className="annot-comment-body">{n.body}</div>
                </li>
              ))}
            </ul>
          ) : <div className="empty">No annotations on this artifact yet.</div>}
          <div className="sched-add-row">
            <input className="filter" placeholder="annotate this artifact (markdown/HTML/text)" value={note}
              onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }} />
            <button className="sched-add-btn" onClick={submitNote} disabled={!note.trim()}>Annotate</button>
          </div>
        </>
      ) : null}

      <div className="tasks-section"><span>Links</span></div>
      <div className="req-links">
        {art.requirementId ? <Chip>req {art.requirementId}</Chip> : null}
        {art.taskId ? <Chip>task {art.taskId}</Chip> : null}
        {art.sessionKey ? <Chip>session</Chip> : null}
        <Chip>{art.linkedMemoryIds.length} memor{art.linkedMemoryIds.length === 1 ? 'y' : 'ies'}</Chip>
      </div>
    </div>
  );
}

/** Formats that have a meaningful rendered view distinct from their source. */
const RENDERABLE = new Set(['markdown', 'html', 'svg', 'mermaid', 'code']);

function ArtifactPreview({ art, content }: { art: ArtifactRecord; content: string }): React.ReactElement {
  // §AV-2 — Source ⇄ Preview toggle. Defaults to the rendered view; the toggle
  // is offered for every renderable format so the user can always see the source.
  const [view, setView] = useState<'preview' | 'source'>('preview');
  // §AV-5 — trusted interactivity. HTML/SVG render in a LOCKED sandbox by default
  // (no scripts); the user can explicitly opt a single artifact into running its
  // scripts (still no network — a strict CSP blocks it). Reset on artifact switch.
  const [interactive, setInteractive] = useState(false);
  // §3 D3 — opt into a process-isolated, src-gated <webview> for an html
  // prototype (electron only; the main process hardens every attach). Reset on switch.
  const [webviewMode, setWebviewMode] = useState(false);
  const webviewRef = React.useRef<{ reload: () => void } | null>(null);
  const hasWebview = typeof window !== 'undefined' && 'customElements' in window && !!window.customElements.get?.('webview');
  useEffect(() => { setInteractive(false); setWebviewMode(false); }, [art.id]);
  if (!content.trim()) {
    return <div className="empty">{art.path ? 'Loading preview…' : 'No content to preview.'}</div>;
  }
  const showToggle = RENDERABLE.has(art.format);
  const canInteract = art.format === 'html' || art.format === 'svg';
  const source = (
    <pre className="annot-quote art-source">{content}</pre>
  );
  const preview = (() => {
    // Markdown renders through the SAME renderer the chat uses (react-markdown +
    // remark-gfm, fenced code via the shared highlighter).
    if (art.format === 'markdown') {
      return <div className="art-preview md"><Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{content}</Markdown></div>;
    }
    // `code` → a fenced block in the chosen language so the shared highlighter lights it up.
    if (art.format === 'code') {
      const fence = '```' + (art.language ?? '') + '\n' + content + '\n```';
      // F3 (deferred) — a jsx/tsx artifact is a React component. Live in-webview
      // rendering needs a JSX transform dependency + a `react` artifact format
      // (a types/core change), so for now show the source with a short note.
      const react = isReactArtifact(art);
      return (
        <div className="art-preview md">
          {react ? <div className="art-react-note">React component — live preview coming soon; showing source.</div> : null}
          <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{fence}</Markdown>
        </div>
      );
    }
    // `mermaid` → render via a fenced ```mermaid block (the shared renderer draws
    // the diagram when mermaid support is present; otherwise it shows the source).
    if (art.format === 'mermaid') {
      const fence = '```mermaid\n' + content + '\n```';
      return <div className="art-preview md"><Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{fence}</Markdown></div>;
    }
    // HTML + SVG render in an EMPTY sandbox iframe: no scripts, forms, top
    // navigation, or same-origin. SVG is wrapped in a minimal centered document.
    if (art.format === 'html' || art.format === 'svg') {
      // §3 D2 — resolve any `br-pending-gen://` async-placeholder tokens (from an
      // interactive-prototype turn) into self-contained inline SVGs before render.
      // Idempotent: artifacts with no tokens are returned unchanged.
      const resolved = inlinePlaceholders(content);
      // When interactive, inject a strict CSP that permits inline script/style but
      // BLOCKS all network (default-src 'none') — scripts run, exfiltration can't.
      const csp = interactive
        ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`
        : '';
      const doc = art.format === 'svg'
        ? `<!doctype html><meta charset="utf-8">${csp}<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:transparent}svg{max-width:100%;max-height:100%}</style>${resolved}`
        // Inject the network-blocking CSP into <head> when present; otherwise
        // PREPEND it (String.replace returns the unchanged string on no match, so
        // the old `|| (csp + content)` fallback never fired — an interactive
        // artifact with no <head> would then run scripts with NO CSP).
        : (csp
            ? (/<head[^>]*>/i.test(resolved)
                ? resolved.replace(/<head[^>]*>/i, (m) => m + csp)
                : csp + resolved)
            : resolved);
      // §3 D3 — a process-isolated <webview> for the prototype: scripts run, but a
      // forced network-blocking CSP + the main-process harden/src-gate keep it
      // sealed. data:text/html is allowed by the gate. (electron only.)
      if (art.format === 'html' && webviewMode && hasWebview) {
        const wvCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;
        const wvDoc = /<head[^>]*>/i.test(resolved) ? resolved.replace(/<head[^>]*>/i, (m) => m + wvCsp) : wvCsp + resolved;
        return React.createElement('webview', {
          key: `wv-${art.id}`,
          ref: webviewRef,
          className: 'art-html-frame',
          src: `data:text/html;charset=utf-8,${encodeURIComponent(wvDoc)}`,
          partition: 'persist:proto-preview',
          allowpopups: 'false',
        });
      }
      // sandbox: locked ('') by default; 'allow-scripts' only after explicit opt-in
      // (never allow-same-origin, so the frame can't reach the parent app).
      return <iframe className="art-html-frame" sandbox={interactive ? 'allow-scripts' : ''} srcDoc={doc} title={`Preview of ${art.title}`} />;
    }
    return source;
  })();
  return (
    <div className={`art-preview-wrap ${art.format}`}>
      {showToggle ? (
        <div className="art-view-bar">
          <div className="art-view-toggle">
            <button className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')}>Preview</button>
            <button className={view === 'source' ? 'active' : ''} onClick={() => setView('source')}>Source</button>
          </div>
          {canInteract && view === 'preview' ? (
            <label className="art-interactive" title="Run this artifact's scripts in a locked sandbox (no network access)">
              <input type="checkbox" checked={interactive} onChange={(e) => setInteractive(e.target.checked)} />
              <span>Enable interactivity{interactive ? ' · scripts on, no network' : ''}</span>
            </label>
          ) : null}
          {canInteract && view === 'preview' && art.format === 'html' && hasWebview ? (
            <label className="art-interactive" title="Render in a process-isolated, src-gated webview (still no network)">
              <input type="checkbox" checked={webviewMode} onChange={(e) => setWebviewMode(e.target.checked)} />
              <span>Sandboxed webview</span>
            </label>
          ) : null}
          {webviewMode && hasWebview ? (
            <button className="art-wv-reload" title="Reload the prototype" onClick={() => webviewRef.current?.reload?.()}>Reload</button>
          ) : null}
        </div>
      ) : null}
      {view === 'preview' ? preview : source}
    </div>
  );
}
