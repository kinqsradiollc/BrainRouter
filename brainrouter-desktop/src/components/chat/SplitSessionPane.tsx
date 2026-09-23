/**
 * ADR-057 D2 — the split chat view's second pane.
 *
 * A live, side-by-side VIEWER of another session, so you can watch a background
 * task or a sibling chat next to your main one. It is deliberately additive and
 * host-safe: it never resumes the session (which would steal the foreground and
 * re-point the main pane) and never runs a turn of its own — running two
 * sessions at once is only safe in multi-agent mode, so input stays with the
 * one active session. Instead it reads the session's transcript from disk
 * (`transcript` query), streams its assistant text off the shared event bus
 * (events are tagged with their `sessionKey`), and offers "Open in main" to
 * jump into it. Rows render through the same `buildRenderRow` the main thread
 * uses, so a tool card or diff looks identical here.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatRow, SessionRow } from '../../types.js';
import type { PanelId } from '../../panels/panelCatalog.js';
import { buildRenderRow } from '../../App/render/renderHelpers.js';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import { Markdown, MD_COMPONENTS } from '../../chat/markdown.js';
import remarkGfm from 'remark-gfm';
import { Icon } from '../../icons.js';
import { shouldReloadOnEvent, splitSessionTitle } from '../../lib/chat/splitSession.js';

type Query = (id: string, name: string, args?: Record<string, unknown>) => void;

interface BrainrouterBridge {
  onEvent(listener: (msg: unknown) => void): () => void;
}

export interface SplitSessionPaneProps {
  sessionKey: string;
  sessions: SessionRow[];
  /** Choose a different session to view in this pane. */
  onPick: (sessionKey: string) => void;
  /** Promote this session into the main pane (a normal resume). */
  onPromote: (sessionKey: string) => void;
  onClose: () => void;
  /** Threaded from App so row actions (open a file, pop a panel) still work. */
  q: Query;
  openFile: (file: string) => void;
  ensurePanel: (id: PanelId) => void;
}


export function SplitSessionPane(props: SplitSessionPaneProps): React.ReactElement {
  const { sessionKey, sessions, q, openFile, ensurePanel } = props;
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [liveText, setLiveText] = useState('');
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const errorsBySession = useRef<Record<string, Array<{ id: number; text: string; detail?: string; ts: number }>>>({});
  const sessionKeyRef = useRef<string | undefined>(sessionKey);
  sessionKeyRef.current = sessionKey;
  const reloadTimer = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(() => {
    void bridgeQuery<{ sessionKey: string; rows: ChatRow[] }>('transcript', { sessionKey }, 8_000)
      .then((result) => setRows(Array.isArray(result?.rows) ? result.rows : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [sessionKey]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => { reloadTimer.current = null; reload(); }, 250);
  }, [reload]);

  // Load (and clear) whenever the viewed session changes.
  useEffect(() => {
    setRows([]); setLiveText(''); setRunning(false); setLoading(true);
    reload();
    return () => { if (reloadTimer.current) window.clearTimeout(reloadTimer.current); };
  }, [sessionKey, reload]);

  // Live: stream assistant text and refresh committed rows for THIS session only.
  useEffect(() => {
    const bridge = (window as unknown as { brainrouter?: BrainrouterBridge }).brainrouter;
    if (!bridge?.onEvent) return;
    return bridge.onEvent((raw) => {
      const msg = raw as { sessionKey?: string; event?: { kind?: string; text?: string; running?: boolean; sessionKey?: string } };
      const key = msg.sessionKey ?? msg.event?.sessionKey ?? '';
      if (key !== sessionKey) return;
      const e = msg.event;
      if (!e?.kind) return;
      if (e.kind === 'turn-start') { setRunning(true); setLiveText(''); }
      else if (e.kind === 'assistant-turn-start') setLiveText('');
      else if (e.kind === 'assistant-delta') setLiveText((t) => (t + (e.text ?? '')).slice(-8_000));
      else if (e.kind === 'turn-complete' || e.kind === 'turn-error') { setRunning(false); setLiveText(''); scheduleReload(); }
      else if (e.kind === 'session-changed' && typeof e.running === 'boolean') setRunning(e.running);
      else if (shouldReloadOnEvent(e.kind)) { if (e.kind === 'assistant-turn-end') setLiveText(''); scheduleReload(); }
    });
  }, [sessionKey, scheduleReload]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [rows, liveText]);

  const renderRow = useMemo(
    () => buildRenderRow({ q, inlineDiffs: {}, openFile, setDiffTarget: () => {}, ensurePanel, setRows, errorsBySession, forkSessionAction: () => {}, sessionKeyRef }),
    [q, openFile, ensurePanel],
  );
  const els = useMemo(() => rows.map((r) => renderRow(r, false)), [rows, renderRow]);

  return (
    <div className="split-pane" aria-label="Second chat session">
      <div className="split-pane-head">
        <select
          className="split-pane-picker"
          value={sessionKey}
          onChange={(event) => props.onPick(event.target.value)}
          aria-label="Session shown in the split pane"
          title={splitSessionTitle(sessions, sessionKey)}
        >
          {sessions.some((s) => s.sessionKey === sessionKey) ? null : <option value={sessionKey}>{splitSessionTitle(sessions, sessionKey)}</option>}
          {sessions.slice(0, 40).map((s) => <option key={s.sessionKey} value={s.sessionKey}>{splitSessionTitle(sessions, s.sessionKey)}</option>)}
        </select>
        {running ? <span className="split-pane-running" title="This session has a turn in flight"><span className="spinner" /> working</span> : null}
        <div className="split-pane-actions">
          <button className="chip ghost" type="button" onClick={() => props.onPromote(sessionKey)} title="Open this session in the main chat">Open in main</button>
          <button className="icon-btn" type="button" aria-label="Close split" title="Close split view" onClick={props.onClose}><Icon name="close" size={12} /></button>
        </div>
      </div>
      <div className="split-pane-body">
        {loading && !rows.length ? <div className="split-pane-empty"><span className="spinner" /> Loading…</div> : null}
        {!loading && !rows.length && !liveText ? <div className="split-pane-empty">This session has no messages yet.</div> : null}
        {els}
        {liveText ? (
          <div className="msg assistant split-pane-live">
            <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{liveText}</Markdown>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>
      <div className="split-pane-note">A live view — input goes to the main chat. Use “Open in main” to reply here.</div>
    </div>
  );
}
