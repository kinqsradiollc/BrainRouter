/**
 * DESK-2b — the chat surface: streaming markdown, collapsible tool cards,
 * plan checklist, live reasoning/status line, Stop. Three-pane
 * Claude-desktop-style shell (sessions rail · chat · context sidebar) over
 * the typed agent protocol. Approvals/structured questions land in DESK-3.
 */
import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentEvent, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';

type PlanItem = { step: string; status: 'pending' | 'in_progress' | 'completed' };

type ChatRow =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string }
  | { id: number; kind: 'status'; text: string }
  | { id: number; kind: 'tool'; tool: string; summary: string; preview?: string; ok: boolean; child?: string }
  | { id: number; kind: 'plan'; items: PlanItem[]; explanation?: string };

interface SessionRow { sessionKey: string; firstUserMessage?: string }
interface FleetRow { kind: string; id: string; label: string }

let nextId = 0;
const rid = () => ++nextId;

function ToolCard({ row }: { row: Extract<ChatRow, { kind: 'tool' }> }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool-card ${row.ok ? 'ok' : 'fail'}`}>
      <button className="tool-head" onClick={() => row.preview && setOpen((o) => !o)}>
        <span className="tool-dot" />
        <span className="tool-name">{row.child ? `[${row.child}] ` : ''}{row.tool}</span>
        <span className="tool-summary">{row.summary}</span>
        {row.preview ? <span className="tool-chevron">{open ? '▾' : '▸'}</span> : null}
      </button>
      {open && row.preview ? <pre className="tool-preview">{row.preview}</pre> : null}
    </div>
  );
}

function PlanCard({ items, explanation }: { items: PlanItem[]; explanation?: string }): React.ReactElement {
  return (
    <div className="plan-card">
      <div className="plan-title">Plan{explanation ? <span className="plan-why"> — {explanation}</span> : null}</div>
      {items.map((it, i) => (
        <div key={i} className={`plan-item ${it.status}`}>
          <span className="plan-mark">{it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '◐' : '○'}</span>
          {it.step}
        </div>
      ))}
    </div>
  );
}

export function App(): React.ReactElement {
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [statusLine, setStatusLine] = useState('');
  const [reasoningTail, setReasoningTail] = useState('');
  const [liveText, setLiveText] = useState('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [info, setInfo] = useState<{ sessionKey?: string; model?: string; workspaceRoot?: string }>({});
  const [hostUp, setHostUp] = useState(false);
  const liveBuf = useRef('');
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const push = (row: ChatRow) => setRows((r) => [...r, row]);
    const flushAssistant = () => {
      const text = liveBuf.current.trim();
      liveBuf.current = '';
      setLiveText('');
      if (text) push({ id: rid(), kind: 'assistant', text });
    };
    const off = window.brainrouter.onEvent((msg: AgentEventMessage) => {
      setHostUp(true);
      const e: AgentEvent = msg.event;
      switch (e.kind) {
        case 'status': setStatusLine(e.text); break;
        case 'reasoning-delta': setReasoningTail((t) => (t + e.text).slice(-200)); break;
        case 'assistant-turn-start': liveBuf.current = ''; setLiveText(''); break;
        case 'assistant-delta': liveBuf.current += e.text; setLiveText(liveBuf.current); break;
        case 'assistant-turn-end': flushAssistant(); break;
        case 'tool-start': break; // card lands at tool-end with the result
        case 'tool-end':
          push({ id: rid(), kind: 'tool', tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok });
          break;
        case 'child-tool-end':
          push({ id: rid(), kind: 'tool', tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok, child: `${e.role}·${e.childId.slice(-4)}` });
          break;
        case 'child-complete':
          push({ id: rid(), kind: 'status', text: `${e.status === 'completed' ? '🏁' : '💥'} agent ${e.childId} (${e.role}) ${e.status}` });
          break;
        case 'plan-update': push({ id: rid(), kind: 'plan', items: e.items, explanation: e.explanation }); break;
        case 'compaction': push({ id: rid(), kind: 'status', text: `📦 Compacted ${e.droppedMessages} → kept ${e.keptMessages}` }); break;
        case 'memory': push({ id: rid(), kind: 'status', text: `${e.level === 'warn' ? '⚠' : '·'} ${e.text}` }); break;
        case 'turn-complete': {
          flushAssistant();
          setRows((r) => (r.some((x) => x.kind === 'assistant') ? r : [...r, { id: rid(), kind: 'assistant', text: e.answer }]));
          setRunning(false); setStatusLine(''); setReasoningTail('');
          refreshSidebar();
          break;
        }
        case 'turn-error':
          flushAssistant();
          push({ id: rid(), kind: 'status', text: `✗ ${e.message}` });
          setRunning(false); setStatusLine(''); setReasoningTail('');
          break;
        case 'query-result': handleQueryResult(e.id, e.ok ? e.result : undefined); break;
        default: break;
      }
      queueMicrotask(() => chatEnd.current?.scrollIntoView({ behavior: 'auto' }));
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
    setRows((r) => [...r, { id: rid(), kind: 'user', text: prompt }]);
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
          {rows.map((r) => {
            switch (r.kind) {
              case 'user': return <div key={r.id} className="row"><div className="user">{r.text}</div></div>;
              case 'assistant': return (
                <div key={r.id} className="row assistant md">
                  <Markdown remarkPlugins={[remarkGfm]}>{r.text}</Markdown>
                </div>
              );
              case 'tool': return <div key={r.id} className="row"><ToolCard row={r} /></div>;
              case 'plan': return <div key={r.id} className="row"><PlanCard items={r.items} explanation={r.explanation} /></div>;
              case 'status': return <div key={r.id} className="row status">{r.text}</div>;
            }
          })}
          {liveText ? (
            <div className="row assistant md live">
              <Markdown remarkPlugins={[remarkGfm]}>{liveText}</Markdown>
              <span className="caret">▍</span>
            </div>
          ) : null}
          {running && !liveText ? (
            <div className="row status working">
              <span className="spinner" /> {statusLine || 'Working…'}{reasoningTail ? <span className="reasoning"> · 💭 {reasoningTail}</span> : null}
            </div>
          ) : null}
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
                if (e.key === 'Escape' && running) window.brainrouter.send({ kind: 'interrupt' });
              }}
            />
            {running ? (
              <button className="stop" onClick={() => window.brainrouter.send({ kind: 'interrupt' })}>Stop</button>
            ) : (
              <button disabled={!draft.trim()} onClick={submit}>Send</button>
            )}
          </div>
          <div className="composer-hint">Enter to send · Shift+Enter newline · Esc stops a running turn</div>
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
