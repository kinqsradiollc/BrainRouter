/**
 * DESK-2b — the chat surface: streaming markdown, collapsible tool cards,
 * plan checklist, live reasoning/status line, Stop. Three-pane
 * Claude-desktop-style shell (sessions rail · chat · context sidebar) over
 * the typed agent protocol. Approvals/structured questions land in DESK-3.
 */
import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentEvent, AgentEventMessage, InteractionRequest } from '@kinqs/brainrouter-agent-protocol';

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
  const [interaction, setInteraction] = useState<InteractionRequest | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelDraft, setModelDraft] = useState('');
  const [workspaces, setWorkspaces] = useState<{ current: string | null; recents: string[] }>({ current: null, recents: [] });
  const [termLines, setTermLines] = useState<string[]>([]);
  const [bottomTab, setBottomTab] = useState<'terminal' | 'tools'>('terminal');
  const [toolLog, setToolLog] = useState<Array<{ id: number; tool: string; ok: boolean; summary: string }>>([]);
  const [sideTab, setSideTab] = useState<'context' | 'files'>('context');
  const [changedFiles, setChangedFiles] = useState<Array<{ status: string; path: string }>>([]);
  const [diffView, setDiffView] = useState<{ path: string; diff: string } | null>(null);
  const [tokens, setTokens] = useState<{ promptTokens: number; completionTokens: number; turns: number } | null>(null);
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
        case 'tool-end': {
          push({ id: rid(), kind: 'tool', tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok });
          setToolLog((t) => [...t.slice(-199), { id: rid(), tool: e.tool, ok: e.ok, summary: e.summary }]);
          if ((e.tool === 'run_command' || e.tool === 'task_output') && (e.preview || e.summary)) {
            const text = (e.preview ?? e.summary).split('\n').slice(0, 40);
            setTermLines((l) => [...l.slice(-400), `$ ${e.tool}${e.ok ? '' : ' ✗'}`, ...text]);
          }
          break;
        }
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
          window.brainrouter.send({ kind: 'query', id: 'q-files', name: 'changed-files' });
          break;
        }
        case 'turn-error':
          flushAssistant();
          push({ id: rid(), kind: 'status', text: `✗ ${e.message}` });
          setRunning(false); setStatusLine(''); setReasoningTail('');
          break;
        case 'interaction-request': setInteraction(e.request); setPicked([]); break;
        case 'session-changed':
          if (e.loadedMessages >= 0) {
            setRows([{ id: rid(), kind: 'status', text: e.loadedMessages > 0 ? `Resumed ${e.sessionKey} (${e.loadedMessages} prior messages).` : 'New chat started.' }]);
          }
          setInfo((i) => ({ ...i, sessionKey: e.sessionKey, model: e.model || i.model }));
          refreshSidebar();
          break;
        case 'tokens-updated': setTokens({ promptTokens: e.promptTokens, completionTokens: e.completionTokens, turns: e.turns }); break;
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
    if (id === 'q-files' && Array.isArray(result)) setChangedFiles(result as Array<{ status: string; path: string }>);
    if (id === 'q-diff' && result && typeof result === 'object') setDiffView(result as { path: string; diff: string });
  }

  function refreshSidebar(): void {
    void window.brainrouter.workspaceRecents().then(setWorkspaces).catch(() => {});
    window.brainrouter.send({ kind: 'query', id: 'q-sessions', name: 'list-sessions' });
    window.brainrouter.send({ kind: 'query', id: 'q-fleet', name: 'fleet' });
    window.brainrouter.send({ kind: 'query', id: 'q-info', name: 'session-info' });
    window.brainrouter.send({ kind: 'query', id: 'q-files', name: 'changed-files' });
  }

  function answerInteraction(response: { type: 'confirm'; approved: boolean } | { type: 'choice'; labels: string[] } | { type: 'dismissed' }): void {
    if (!interaction) return;
    window.brainrouter.send({ kind: 'interaction-response', id: interaction.id, response });
    setInteraction(null);
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
        <button className="rail-btn primary" onClick={() => window.brainrouter.send({ kind: 'new-session' })}>+ New chat</button>
        <div className="rail-section">Workspaces</div>
        <div className="session active" title={workspaces.current ?? ''}>{workspaces.current?.split('/').pop() ?? '…'}</div>
        {workspaces.recents.filter((w) => w !== workspaces.current).slice(0, 5).map((w) => (
          <div key={w} className="session" title={w} onClick={() => void window.brainrouter.openWorkspace(w)}>{w.split('/').pop()}</div>
        ))}
        <button className="rail-btn" onClick={() => void window.brainrouter.addWorkspace()}>Add workspace…</button>
        <div className="rail-section">Chats</div>
        {sessions.map((s) => (
          <div key={s.sessionKey} className={`session${s.sessionKey === info.sessionKey ? ' active' : ''}`} title={s.sessionKey}
               onClick={() => window.brainrouter.send({ kind: 'resume-session', sessionKey: s.sessionKey })}>
            {s.firstUserMessage || s.sessionKey}
          </div>
        ))}
        <button className="rail-btn" onClick={() => { setModelDraft(info.model ?? ''); setSettingsOpen(true); }}>⚙ Settings</button>
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
        <div className="side-tabs">
          <button className={sideTab === 'context' ? 'on' : ''} onClick={() => setSideTab('context')}>Context</button>
          <button className={sideTab === 'files' ? 'on' : ''} onClick={() => { setSideTab('files'); window.brainrouter.send({ kind: 'query', id: 'q-files', name: 'changed-files' }); }}>
            Files{changedFiles.length ? ` (${changedFiles.length})` : ''}
          </button>
        </div>
        {sideTab === 'files' ? (
          diffView ? (
            <div className="diff-pane">
              <button className="rail-btn" onClick={() => setDiffView(null)}>← {diffView.path}</button>
              <pre className="diff">{diffView.diff.split('\n').map((line, i) => (
                <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>{line || ' '}</div>
              ))}</pre>
            </div>
          ) : (
            <div>
              {changedFiles.length === 0 ? <div className="kv"><span>working tree clean</span></div> : changedFiles.map((f) => (
                <div key={f.path} className="file-row" onClick={() => window.brainrouter.send({ kind: 'query', id: 'q-diff', name: 'file-diff', args: { path: f.path } })}>
                  <span className={`fstat s-${f.status.replace('?', 'u')}`}>{f.status}</span>{f.path}
                </div>
              ))}
            </div>
          )
        ) : (<>
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
        <h2>Tokens</h2>
        <div className="kv"><span>Session</span><b>{tokens ? `${tokens.promptTokens.toLocaleString()} in / ${tokens.completionTokens.toLocaleString()} out · ${tokens.turns} turns` : '—'}</b></div>
        <h2>Settings</h2>
        <div className="kv"><span>Source</span><b>~/.config/brainrouter</b></div>
        <div className="kv"><span>Shared with</span><b>brainrouter CLI</b></div>
        </>)}
      </aside>

      <section className="bottom">
        <div className="side-tabs">
          <button className={bottomTab === 'terminal' ? 'on' : ''} onClick={() => setBottomTab('terminal')}>Terminal</button>
          <button className={bottomTab === 'tools' ? 'on' : ''} onClick={() => setBottomTab('tools')}>Tool calls{toolLog.length ? ` (${toolLog.length})` : ''}</button>
        </div>
        {bottomTab === 'terminal' ? (
          <pre className="term">{termLines.length ? termLines.join('\n') : 'Shell output from run_command / background tasks appears here.'}</pre>
        ) : (
          <div className="toollog">
            {toolLog.length === 0 ? <div className="kv"><span>no tool calls yet</span></div> : toolLog.slice().reverse().map((t) => (
              <div key={t.id} className="toollog-row"><span className={t.ok ? 'okdot' : 'faildot'} />{t.tool} — {t.summary}</div>
            ))}
          </div>
        )}
      </section>

      {interaction ? (
        <div className="overlay" onKeyDown={(e) => {
          if (interaction.type === 'confirm') {
            if (e.key === '1' || e.key === 'Enter') answerInteraction({ type: 'confirm', approved: true });
            if (e.key === '2' || e.key === 'Escape') answerInteraction({ type: 'confirm', approved: false });
          } else if (e.key === 'Escape') answerInteraction({ type: 'dismissed' });
        }} tabIndex={-1} ref={(el) => el?.focus()}>
          <div className={`dialog${interaction.type === 'confirm' && interaction.dangerous ? ' dangerous' : ''}`}>
            {interaction.type === 'confirm' ? (
              <>
                <div className="dialog-title">{interaction.title}</div>
                {interaction.detail ? <pre className="dialog-detail">{interaction.detail}</pre> : null}
                <div className="dialog-actions">
                  <button className="approve" onClick={() => answerInteraction({ type: 'confirm', approved: true })}>[1] Allow</button>
                  <button className="deny" onClick={() => answerInteraction({ type: 'confirm', approved: false })}>[2] Deny</button>
                </div>
              </>
            ) : (
              <>
                <div className="dialog-title">{interaction.question}</div>
                <div className="dialog-options">
                  {interaction.options.map((o) => (
                    <label key={o.label} className={`opt${picked.includes(o.label) ? ' picked' : ''}`}
                      onClick={() => setPicked((p) => interaction.multiSelect
                        ? (p.includes(o.label) ? p.filter((x) => x !== o.label) : [...p, o.label])
                        : [o.label])}>
                      <b>{o.label}</b><span>{o.description}</span>
                    </label>
                  ))}
                </div>
                <div className="dialog-actions">
                  <button className="approve" disabled={picked.length === 0}
                    onClick={() => answerInteraction({ type: 'choice', labels: picked })}>Answer</button>
                  <button className="deny" onClick={() => answerInteraction({ type: 'dismissed' })}>Dismiss</button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}>
          <div className="dialog settings">
            <div className="dialog-title">Settings</div>
            <div className="settings-row">
              <label>Model</label>
              <input value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} placeholder="e.g. gpt-5.5 / claude-opus-4-8" />
            </div>
            <div className="settings-note">Saved to <code>~/.config/brainrouter/config.json</code> — shared with the brainrouter CLI. Provider/endpoint/API keys come from the same file (edit via the CLI's /config or /login for now).</div>
            <div className="dialog-actions">
              <button className="approve" disabled={!modelDraft.trim()} onClick={() => {
                window.brainrouter.send({ kind: 'set-model', model: modelDraft.trim(), persist: true });
                setSettingsOpen(false);
              }}>Save</button>
              <button className="deny" onClick={() => setSettingsOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
