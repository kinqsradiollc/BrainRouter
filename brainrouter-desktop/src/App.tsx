/**
 * DESK-4c — the app shell: left rail · chat thread · resizable panel columns.
 * Panels open as full-height window columns right of the chat (drag the left
 * edge to resize). Every CLI slash command surfaces here: ⌘K palette, the
 * composer "/" popup, and the categorized Settings modal.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// react-markdown's return type clashes with the workspace-hoisted @types/react;
// the runtime component is a plain function component.
const Markdown = ReactMarkdown as unknown as React.ComponentType<{ remarkPlugins?: unknown[]; children: string }>;
import type { AgentEvent, AgentEventMessage, InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import {
  DiffPanel, FilesPanel, FileViewerPanel, Panel, PanelPicker, PlanPanel, SearchPanel,
  TasksPanel, TerminalPanel, ToolsPanel, PANEL_DEFS, type PanelId, type SearchHit,
} from './panels.js';
import { buildCommandList, runCommand, type CmdCtx, type CommandsCatalog, type DeskCommand, type SettingsSection } from './commands.js';
import { CommandList, CommandPalette, filterCommands } from './palette.js';
import { SettingsDialog, type ConfigSnapshot } from './settings.js';
import { installDevBridge } from './devBridge.js';

installDevBridge();

type PlanItem = { step: string; status: 'pending' | 'in_progress' | 'completed' };
type ToolItem = { id: number; tool: string; summary: string; preview?: string; ok: boolean; child?: string };

type ChatRow =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string }
  | { id: number; kind: 'status'; text: string }
  | { id: number; kind: 'tool-group'; items: ToolItem[] };

interface SessionRow { sessionKey: string; firstUserMessage?: string }
interface FleetRow { kind: string; id: string; label: string }

let nextId = 0;
const rid = () => ++nextId;

const DEFAULT_WIDTHS: Partial<Record<PanelId, number>> = { file: 460, diff: 430, terminal: 420, files: 300 };

function fmt(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result) && result.every((x) => typeof x === 'string')) return result.join('\n');
  return JSON.stringify(result, null, 2);
}

function download(filename: string, content: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function ToolGroup({ row }: { row: Extract<ChatRow, { kind: 'tool-group' }> }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [openItem, setOpenItem] = useState<number | null>(null);
  const label = row.items.length === 1
    ? `${row.items[0].child ? `[${row.items[0].child}] ` : ''}${row.items[0].tool} — ${row.items[0].summary}`
    : `Ran ${row.items.length} commands`;
  const failed = row.items.some((i) => !i.ok);
  return (
    <div className="step">
      <button className="step-head" onClick={() => setOpen((o) => !o)}>
        <span className={`step-dot ${failed ? 'fail' : 'ok'}`} />
        <span className="step-label">{label}</span>
        <span className="step-chevron">{open ? '⌄' : '›'}</span>
      </button>
      {open ? (
        <div className="step-body">
          {row.items.map((t) => (
            <div key={t.id} className="tool-card-mini">
              <button className="tool-head" onClick={() => t.preview && setOpenItem(openItem === t.id ? null : t.id)}>
                <span className={`step-dot ${t.ok ? 'ok' : 'fail'}`} />
                <span className="tool-name">{t.child ? `[${t.child}] ` : ''}{t.tool}</span>
                <span className="tool-summary">{t.summary}</span>
                {t.preview ? <span className="step-chevron">{openItem === t.id ? '⌄' : '›'}</span> : null}
              </button>
              {openItem === t.id && t.preview ? <pre className="tool-preview">{t.preview}</pre> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A full-height workbench column with a drag-to-resize grip on its left edge. */
function PanelColumn({ width, onWidth, children }: {
  width: number;
  onWidth: (w: number) => void;
  children: React.ReactNode;
}): React.ReactElement {
  const [drag, setDrag] = useState(false);
  return (
    <div className="panel-col" style={{ width }}>
      <div className={`col-grip${drag ? ' active' : ''}`} title="Drag to resize"
        onPointerDown={(e) => {
          e.preventDefault();
          setDrag(true);
          const startX = e.clientX;
          const startW = width;
          const move = (ev: PointerEvent) => onWidth(Math.max(240, Math.min(880, startW + (startX - ev.clientX))));
          const up = () => { setDrag(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }} />
      {children}
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
  const [workspaces, setWorkspaces] = useState<{ current: string | null; recents: string[] }>({ current: null, recents: [] });
  const [railOpen, setRailOpen] = useState(true);

  // Workbench panel columns
  const [openPanels, setOpenPanels] = useState<PanelId[]>(['tasks']);
  const [panelWidths, setPanelWidths] = useState<Partial<Record<PanelId, number>>>({});
  const [termLines, setTermLines] = useState<string[]>([]);
  const [toolLog, setToolLog] = useState<Array<{ id: number; tool: string; ok: boolean; summary: string }>>([]);
  const [changedFiles, setChangedFiles] = useState<Array<{ status: string; path: string }>>([]);
  const [diffView, setDiffView] = useState<{ path: string; diff: string } | null>(null);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [fileView, setFileView] = useState<{ path: string; content: string; error?: string } | null>(null);
  const [gitInfo, setGitInfo] = useState<{ repo: string; branch: string | null; insertions: number; deletions: number } | null>(null);
  const [tokens, setTokens] = useState<{ promptTokens: number; completionTokens: number; turns: number } | null>(null);
  const [lastPlan, setLastPlan] = useState<{ items: PlanItem[]; explanation?: string } | null>(null);
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);

  // Command surfaces + settings
  const [catalog, setCatalog] = useState<CommandsCatalog | null>(null);
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [usageLines, setUsageLines] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settings, setSettings] = useState<{ open: boolean; section: SettingsSection }>({ open: false, section: 'general' });
  const [infoDialog, setInfoDialog] = useState<{ title: string; body: string } | null>(null);
  const [toast, setToast] = useState('');
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [codeFont, setCodeFont] = useState(() => localStorage.getItem('br-code-font') ?? '');

  const liveBuf = useRef('');
  const chatEnd = useRef<HTMLDivElement>(null);
  const commands = useMemo(() => buildCommandList(catalog), [catalog]);

  const q = (id: string, name: string, args?: Record<string, unknown>) =>
    window.brainrouter.send({ kind: 'query', id, name, args });

  function togglePanel(id: PanelId): void {
    setOpenPanels((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }
  function ensurePanel(id: PanelId): void {
    setOpenPanels((p) => (p.includes(id) ? p : [...p, id]));
  }
  function openFile(path: string): void {
    ensurePanel('file');
    q('q-read', 'read-file', { path });
  }
  function openSettings(section: SettingsSection): void {
    setSettings({ open: true, section });
    q('q-snapshot', 'config-snapshot');
    q('q-usage', 'usage-breakdown');
  }

  const cmdCtx: CmdCtx = {
    send: (c) => window.brainrouter.send(c as never),
    query: q,
    ensurePanel,
    openSettings,
    info: (title, body) => setInfoDialog({ title, body }),
    toast: setToast,
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((p) => !p); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--mono',
      codeFont.trim() ? `"${codeFont.trim()}", "SF Mono", Consolas, monospace` : '"SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace');
    localStorage.setItem('br-code-font', codeFont);
  }, [codeFont]);

  useEffect(() => {
    const push = (row: ChatRow) => setRows((r) => [...r, row]);
    const pushTool = (item: ToolItem) => setRows((r) => {
      const last = r[r.length - 1];
      if (last && last.kind === 'tool-group') {
        return [...r.slice(0, -1), { ...last, items: [...last.items, item] }];
      }
      return [...r, { id: rid(), kind: 'tool-group', items: [item] }];
    });
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
        case 'tool-end': {
          pushTool({ id: rid(), tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok });
          setToolLog((t) => [...t.slice(-199), { id: rid(), tool: e.tool, ok: e.ok, summary: e.summary }]);
          if ((e.tool === 'run_command' || e.tool === 'task_output') && (e.preview || e.summary)) {
            const text = (e.preview ?? e.summary).split('\n').slice(0, 40);
            setTermLines((l) => [...l.slice(-400), `$ ${e.tool}${e.ok ? '' : ' ✗'}`, ...text]);
          }
          break;
        }
        case 'child-tool-end':
          pushTool({ id: rid(), tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok, child: `${e.role}·${e.childId.slice(-4)}` });
          break;
        case 'child-complete':
          push({ id: rid(), kind: 'status', text: `${e.status === 'completed' ? '🏁' : '💥'} agent ${e.childId} (${e.role}) ${e.status}` });
          break;
        case 'plan-update':
          setLastPlan({ items: e.items, explanation: e.explanation });
          push({ id: rid(), kind: 'status', text: '☰ Updated the plan' });
          break;
        case 'compaction': push({ id: rid(), kind: 'status', text: `Compacted ${e.droppedMessages} → kept ${e.keptMessages}` }); break;
        case 'memory': push({ id: rid(), kind: 'status', text: `${e.level === 'warn' ? '⚠ ' : ''}${e.text}` }); break;
        case 'tokens-updated': setTokens({ promptTokens: e.promptTokens, completionTokens: e.completionTokens, turns: e.turns }); break;
        case 'interaction-request': setInteraction(e.request); setPicked([]); break;
        case 'session-changed':
          if (e.loadedMessages >= 0) {
            setRows([{ id: rid(), kind: 'status', text: e.loadedMessages > 0 ? `Resumed ${e.sessionKey} (${e.loadedMessages} prior messages).` : 'New chat started.' }]);
            setSearchHits(null);
          }
          setInfo((i) => ({ ...i, sessionKey: e.sessionKey, model: e.model || i.model }));
          refreshSidebar();
          break;
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
        case 'query-result': handleQueryResult(e.id, e.ok ? e.result : undefined, e.ok ? undefined : (e as { error?: string }).error); break;
        default: break;
      }
      queueMicrotask(() => chatEnd.current?.scrollIntoView({ behavior: 'auto' }));
    });
    refreshSidebar();
    q('q-catalog', 'commands-catalog');
    q('q-snapshot', 'config-snapshot');
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleQueryResult(id: string, result: unknown, error?: string): void {
    if (error) { setToast(`✗ ${error}`); return; }
    switch (id) {
      case 'q-sessions': if (Array.isArray(result)) setSessions(result as SessionRow[]); return;
      case 'q-fleet': if (Array.isArray(result)) setFleet(result as FleetRow[]); return;
      case 'q-info': if (result && typeof result === 'object') setInfo(result as typeof info); return;
      case 'q-files': if (Array.isArray(result)) setChangedFiles(result as Array<{ status: string; path: string }>); return;
      case 'q-diff': if (result && typeof result === 'object') setDiffView(result as { path: string; diff: string }); return;
      case 'q-list': if (result && typeof result === 'object') setAllFiles((result as { files: string[] }).files ?? []); return;
      case 'q-read': if (result && typeof result === 'object') setFileView(result as { path: string; content: string }); return;
      case 'q-git': if (result && typeof result === 'object') setGitInfo(result as typeof gitInfo); return;
      case 'q-catalog': if (result && typeof result === 'object') setCatalog(result as CommandsCatalog); return;
      case 'q-snapshot': if (result && typeof result === 'object') setSnapshot(result as ConfigSnapshot); return;
      case 'q-usage': if (Array.isArray(result)) setUsageLines(result as string[]); return;
      case 'q-search': if (Array.isArray(result)) setSearchHits(result as SearchHit[]); return;
      case 'q-recap': setInfoDialog({ title: 'Session recap', body: fmt(result) }); return;
      case 'q-chapters': {
        const marks = Array.isArray(result) ? result as Array<{ title: string; summary?: string }> : [];
        setInfoDialog({ title: 'Chapters', body: marks.length ? marks.map((m, i) => `${i + 1}. ${m.title}${m.summary ? ` — ${m.summary}` : ''}`).join('\n') : 'No chapter marks in this session yet.' });
        return;
      }
      case 'q-export': {
        const r = result as { filename?: string; content?: string };
        if (r?.filename && typeof r.content === 'string') { download(r.filename, r.content); setToast(`Exported ${r.filename}`); }
        return;
      }
      case 'a-clear': setRows([]); setToast('History cleared.'); return;
      case 'a-compact': setInfoDialog({ title: 'Compaction', body: result ? fmt(result) : 'Nothing to compact yet.' }); return;
      case 'a-pref': q('q-snapshot', 'config-snapshot'); setToast('Saved — shared with the CLI.'); return;
      case 'a-hook': q('q-snapshot', 'config-snapshot'); setToast('Hook updated.'); return;
      case 'a-access': setToast('Access mode set for this session.'); return;
      case 'a-reconnect': q('q-snapshot', 'config-snapshot'); setToast('Reconnect requested.'); return;
      default: return;
    }
  }

  function refreshSidebar(): void {
    void window.brainrouter.workspaceRecents().then(setWorkspaces).catch(() => {});
    q('q-sessions', 'list-sessions');
    q('q-fleet', 'fleet');
    q('q-info', 'session-info');
    q('q-files', 'changed-files');
    q('q-list', 'list-files');
    q('q-git', 'git-info');
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

  const statuses = useMemo(() => new Map(changedFiles.map((f) => [f.path, f.status])), [changedFiles]);
  const sessionTitle = useMemo(() => {
    const firstUser = rows.find((r) => r.kind === 'user') as { text: string } | undefined;
    return firstUser ? firstUser.text.slice(0, 48) : 'New session';
  }, [rows]);

  const slashActive = !slashDismissed && !running && draft.startsWith('/') && !/\s/.test(draft);
  const slashMatches = useMemo(() => (slashActive ? filterCommands(commands, draft) : []), [slashActive, commands, draft]);

  function runSlash(c: DeskCommand): void {
    setDraft('');
    setSlashSel(0);
    runCommand(c, cmdCtx);
  }

  const renderPanel = (id: PanelId): React.ReactElement | null => {
    const def = PANEL_DEFS.find((d) => d.id === id)!;
    const close = () => togglePanel(id);
    switch (id) {
      case 'context': return (
        <Panel key={id} title={def.title} onClose={close}>
          <div className="kv"><span>Host</span><b><span className={`dot ${hostUp ? 'on' : 'off'}`} />{hostUp ? 'online' : 'starting…'}</b></div>
          <div className="kv"><span>Model</span><b>{info.model ?? '—'}</b></div>
          <div className="kv"><span>Workspace</span><b title={info.workspaceRoot}>{info.workspaceRoot?.split('/').pop() ?? '—'}</b></div>
          <div className="kv"><span>Tokens</span><b>{tokens ? `${tokens.promptTokens.toLocaleString()} in / ${tokens.completionTokens.toLocaleString()} out` : '—'}</b></div>
          <div className="kv"><span>Config</span><b>~/.config/brainrouter</b></div>
        </Panel>);
      case 'files': return <Panel key={id} title={def.title} onClose={close}><FilesPanel files={allFiles} statuses={statuses} onOpen={openFile} /></Panel>;
      case 'file': return <Panel key={id} title={fileView?.path ? `File — ${fileView.path.split('/').pop()}` : def.title} onClose={close}><FileViewerPanel view={fileView} /></Panel>;
      case 'diff': return (
        <Panel key={id} title={def.title} onClose={close}>
          <DiffPanel gitInfo={gitInfo} changed={changedFiles} diff={diffView}
            onPick={(p) => q('q-diff', 'file-diff', { path: p })}
            onBack={() => setDiffView(null)} onOpenFile={openFile} />
        </Panel>);
      case 'terminal': return <Panel key={id} title={def.title} onClose={close}><TerminalPanel lines={termLines} /></Panel>;
      case 'tools': return <Panel key={id} title={def.title} onClose={close}><ToolsPanel log={toolLog} /></Panel>;
      case 'tasks': return <Panel key={id} title={def.title} onClose={close}><TasksPanel fleet={fleet} /></Panel>;
      case 'plan': return <Panel key={id} title={def.title} onClose={close}><PlanPanel plan={lastPlan} /></Panel>;
      case 'search': return <Panel key={id} title={def.title} onClose={close}><SearchPanel hits={searchHits} onSearch={(query) => q('q-search', 'search-transcript', { q: query })} /></Panel>;
      default: return null;
    }
  };

  return (
    <div className="app">
      {railOpen ? (
        <nav className="rail">
          <div className="rail-top">
            <button className="icon-btn" title="Toggle sidebar" onClick={() => setRailOpen(false)}>◧</button>
          </div>
          <button className="rail-btn primary" onClick={() => window.brainrouter.send({ kind: 'new-session' })}>＋ New session</button>
          <div className="rail-section">Workspaces</div>
          <div className="session active" title={workspaces.current ?? ''}>{workspaces.current?.split('/').pop() ?? '…'}</div>
          {workspaces.recents.filter((w) => w !== workspaces.current).slice(0, 4).map((w) => (
            <div key={w} className="session" title={w} onClick={() => void window.brainrouter.openWorkspace(w)}>{w.split('/').pop()}</div>
          ))}
          <button className="rail-btn" onClick={() => void window.brainrouter.addWorkspace()}>Add workspace…</button>
          <div className="rail-section">Recents</div>
          <div className="rail-scroll">
            {sessions.map((s) => (
              <div key={s.sessionKey} className={`session${s.sessionKey === info.sessionKey ? ' active' : ''}`} title={s.sessionKey}
                   onClick={() => window.brainrouter.send({ kind: 'resume-session', sessionKey: s.sessionKey })}>
                {s.firstUserMessage || s.sessionKey}
              </div>
            ))}
          </div>
          <button className="rail-btn" onClick={() => setPaletteOpen(true)}>⌘K Commands</button>
          <button className="rail-btn" onClick={() => openSettings('general')}>⚙ Settings</button>
        </nav>
      ) : null}

      <div className="main">
        <header className="topbar">
          {!railOpen ? <button className="icon-btn" title="Open sidebar" onClick={() => setRailOpen(true)}>◨</button> : null}
          <span className="crumb"><b>{gitInfo?.repo ?? info.workspaceRoot?.split('/').pop() ?? 'BrainRouter'}</b><span className="crumb-sep">/</span>{sessionTitle}</span>
          <span className="topbar-right">
            {gitInfo?.branch ? <span className="chip dim" title="branch">⎇ {gitInfo.branch}</span> : null}
            <button className="chip dim" title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}>⌘K</button>
            <PanelPicker open={openPanels} onToggle={togglePanel} />
            <button className="icon-btn" title="Settings" onClick={() => openSettings('general')}>⚙</button>
          </span>
        </header>

        <div className="workrow">
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
                  case 'tool-group': return <div key={r.id} className="row"><ToolGroup row={r} /></div>;
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
                  <span className="spinner" /> {statusLine || 'Working…'}{reasoningTail ? <span className="reasoning"> · {reasoningTail}</span> : null}
                </div>
              ) : null}
              <div ref={chatEnd} />
            </div>
            {gitInfo?.branch && (gitInfo.insertions + gitInfo.deletions > 0) ? (
              <div className="branchbar" onClick={() => ensurePanel('diff')}>
                <span className="gitbranch">⎇ {gitInfo.branch}</span>
                <span><span className="add-n">+{gitInfo.insertions.toLocaleString()}</span> <span className="del-n">-{gitInfo.deletions.toLocaleString()}</span></span>
                <span className="dim">{changedFiles.length} files — click for diff</span>
              </div>
            ) : null}
            <div className="composer">
              <div className="box">
                {slashActive && slashMatches.length ? (
                  <div className="slash-pop">
                    <CommandList commands={commands} filter={draft} selected={slashSel} onPick={runSlash} onHover={setSlashSel} />
                  </div>
                ) : null}
                <textarea
                  rows={2}
                  placeholder={running ? 'Working…' : 'Message BrainRouter…  ( / for commands · ⌘K for the palette )'}
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setSlashSel(0); setSlashDismissed(false); }}
                  onKeyDown={(e) => {
                    if (slashActive && slashMatches.length) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel((s) => Math.min(s + 1, slashMatches.length - 1)); return; }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel((s) => Math.max(s - 1, 0)); return; }
                      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runSlash(slashMatches[Math.min(slashSel, slashMatches.length - 1)]); return; }
                      if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return; }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
                    if (e.key === 'Escape' && running) window.brainrouter.send({ kind: 'interrupt' });
                  }}
                />
                <div className="composer-row">
                  <span className="chip dim" onClick={() => openSettings('permissions')}>
                    {String((snapshot?.prefs as Record<string, unknown> | undefined)?.executionMode ?? 'planning')}
                  </span>
                  <span className="composer-spacer" />
                  <span className="dim model-label">{info.model ?? ''}</span>
                  {running ? (
                    <button className="send stop" onClick={() => window.brainrouter.send({ kind: 'interrupt' })}>■ Stop</button>
                  ) : (
                    <button className="send" disabled={!draft.trim()} onClick={submit}>↑</button>
                  )}
                </div>
              </div>
            </div>
          </main>

          {openPanels.map((id) => (
            <PanelColumn key={id} width={panelWidths[id] ?? DEFAULT_WIDTHS[id] ?? 340}
              onWidth={(w) => setPanelWidths((pw) => ({ ...pw, [id]: w }))}>
              {renderPanel(id)}
            </PanelColumn>
          ))}
        </div>
      </div>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)}
        onRun={(c) => runCommand(c, cmdCtx)} />

      <SettingsDialog
        open={settings.open}
        section={settings.section}
        setSection={(s) => setSettings({ open: true, section: s })}
        onClose={() => setSettings((st) => ({ ...st, open: false }))}
        snapshot={snapshot}
        usageLines={usageLines}
        tokens={tokens}
        commands={commands}
        catalog={catalog}
        onPref={(key, value) => q('a-pref', 'action:set-pref', { key, value })}
        onModelSave={(model) => window.brainrouter.send({ kind: 'set-model', model, persist: true })}
        onAction={(id, name, args) => {
          if (name === 'new-session') { window.brainrouter.send({ kind: 'new-session' }); setSettings((st) => ({ ...st, open: false })); return; }
          q(id, name, args);
        }}
        onRunCommand={(c) => { setSettings((st) => ({ ...st, open: false })); runCommand(c, cmdCtx); }}
        codeFont={codeFont}
        onCodeFont={setCodeFont}
      />

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
                  <button className="approve" onClick={() => answerInteraction({ type: 'confirm', approved: true })}>Allow <kbd>1</kbd></button>
                  <button className="deny" onClick={() => answerInteraction({ type: 'confirm', approved: false })}>Deny <kbd>2</kbd></button>
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

      {infoDialog ? (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setInfoDialog(null); }}>
          <div className="dialog">
            <div className="dialog-title">{infoDialog.title}</div>
            <pre className="dialog-detail">{infoDialog.body}</pre>
            <div className="dialog-actions">
              <button className="deny" onClick={() => setInfoDialog(null)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
