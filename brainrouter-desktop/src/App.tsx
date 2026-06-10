/**
 * DESK-1 — the desktop shell: Claude-desktop-style three-pane layout
 * (sessions rail · chat · context sidebar) wired to the agent host over the
 * typed protocol. This v1 proves the full pipeline — prompt → host →
 * streaming events → painted chat; the rich chat surface (markdown, tool
 * cards, approvals) lands in DESK-2/3 on top of this skeleton.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { AgentEvent, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';

interface ChatRow {
  id: number;
  kind: 'user' | 'assistant' | 'status' | 'tool';
  text: string;
  ok?: boolean;
}

interface SessionRow { sessionKey: string; firstUserMessage?: string }
interface FleetRow { kind: string; id: string; label: string }

let nextId = 0;

export function App(): React.ReactElement {
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [info, setInfo] = useState<{ sessionKey?: string; model?: string; workspaceRoot?: string }>({});
  const [hostUp, setHostUp] = useState(false);
  const liveAssistant = useRef('');
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const push = (row: Omit<ChatRow, 'id'>) => setRows((r) => [...r, { id: ++nextId, ...row }]);
    const flushAssistant = () => {
      if (!liveAssistant.current) return;
      const text = liveAssistant.current;
      liveAssistant.current = '';
      push({ kind: 'assistant', text });
    };
    const off = window.brainrouter.onEvent((msg: AgentEventMessage) => {
      setHostUp(true);
      const e: AgentEvent = msg.event;
      switch (e.kind) {
        case 'status': push({ kind: 'status', text: e.text }); break;
        case 'assistant-delta': liveAssistant.current += e.text; break;
        case 'assistant-turn-end': flushAssistant(); break;
        case 'tool-start': push({ kind: 'tool', text: `${e.tool}(${JSON.stringify(e.args).slice(0, 120)})`, ok: true }); break;
        case 'tool-end': push({ kind: 'tool', text: `${e.tool} — ${e.summary}`, ok: e.ok }); break;
        case 'turn-complete':
          flushAssistant();
          if (e.answer && !rows.some(() => false)) push({ kind: 'assistant', text: e.answer });
          setRunning(false);
          refreshSidebar();
          break;
        case 'turn-error': push({ kind: 'status', text: `✗ ${e.message}` }); setRunning(false); break;
        case 'query-result': handleQueryResult(e.id, e.ok ? e.result : undefined); break;
        default: break;
      }
      queueMicrotask(() => chatEnd.current?.scrollIntoView({ behavior: 'smooth' }));
    });
    refreshSidebar();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleQueryResult(id: string, result: unknown): void {
    if (id === 'q-sessions' && Array.isArray(result)) setSessions(result as SessionRow[]);
    if (id === 'q-fleet' && Array.isArray(result)) setFleet(result as FleetRow[]);
    if (id === 'q-info' && result && typeof result === 'object') setInfo(result as typeof info);
  }

  function refreshSidebar(): void {
    window.brainrouter.send({ kind: 'query', id: 'q-sessions', name: 'list-sessions' });
    window.brainrouter.send({ kind: 'query', id: 'q-fleet', name: 'fleet' });
    window.brainrouter.send({ kind: 'query', id: 'q-info', name: 'session-info' });
  }

  function submit(): void {
    const prompt = draft.trim();
    if (!prompt || running) return;
    setRows((r) => [...r, { id: ++nextId, kind: 'user', text: prompt }]);
    setDraft('');
    setRunning(true);
    window.brainrouter.send({ kind: 'start-turn', prompt });
  }

  return (
    <div className="app">
      <nav className="rail">
        <h1>BrainRouter</h1>
        <div className="session active">{info.sessionKey ? `Current — ${info.sessionKey.slice(0, 18)}…` : 'Current session'}</div>
        {sessions.map((s) => (
          <div key={s.sessionKey} className="session" title={s.sessionKey}>
            {s.firstUserMessage || s.sessionKey}
          </div>
        ))}
      </nav>

      <main className="center">
        <div className="chat">
          {rows.map((r) => (
            <div key={r.id} className="row">
              {r.kind === 'user' && <div className="user">{r.text}</div>}
              {r.kind === 'assistant' && <div className="assistant">{r.text}</div>}
              {r.kind === 'status' && <div className="status">{r.text}</div>}
              {r.kind === 'tool' && <div className={`tool ${r.ok ? 'ok' : 'fail'}`}>{r.text}</div>}
            </div>
          ))}
          <div ref={chatEnd} />
        </div>
        <div className="composer">
          <div className="box">
            <textarea
              rows={2}
              placeholder={running ? 'Working…' : 'Message BrainRouter…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
            />
            {running ? (
              <button onClick={() => window.brainrouter.send({ kind: 'interrupt' })}>Stop</button>
            ) : (
              <button disabled={!draft.trim()} onClick={submit}>Send</button>
            )}
          </div>
        </div>
      </main>

      <aside className="sidebar">
        <h2>Active context</h2>
        <div className="kv"><span>Host</span><b><span className={`dot ${hostUp ? 'on' : 'off'}`} />{hostUp ? 'online' : 'starting…'}</b></div>
        <div className="kv"><span>Model</span><b>{info.model ?? '—'}</b></div>
        <div className="kv"><span>Workspace</span><b title={info.workspaceRoot}>{info.workspaceRoot?.split('/').pop() ?? '—'}</b></div>
        <h2>Running fleet</h2>
        {fleet.length === 0 ? (
          <div className="kv"><span>idle</span></div>
        ) : (
          fleet.map((f) => <div key={f.id} className="kv"><span>{f.kind}</span><b>{f.label}</b></div>)
        )}
        <h2>Settings</h2>
        <div className="kv"><span>Source</span><b>~/.config/brainrouter</b></div>
        <div className="kv"><span>Shared with</span><b>brainrouter CLI</b></div>
      </aside>
    </div>
  );
}
