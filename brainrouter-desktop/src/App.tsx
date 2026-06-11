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
const Markdown = ReactMarkdown as unknown as React.ComponentType<{ remarkPlugins?: unknown[]; components?: Record<string, unknown>; children: string }>;

/** Fenced code blocks render through the same highlighter as the File view. */
const MD_COMPONENTS: Record<string, unknown> = {
  code(props: { inline?: boolean; className?: string; children?: React.ReactNode }) {
    const match = /language-([\w-]+)/.exec(props.className ?? '');
    const text = String(props.children ?? '').replace(/\n$/, '');
    if (props.inline || (!match && !text.includes('\n'))) {
      return <code className={props.className}>{props.children}</code>;
    }
    return (
      <div className="md-code">
        <div className="md-code-bar">
          <span>{match?.[1] ?? 'text'}</span>
          <button className="icon-btn" title="Copy" onClick={() => void navigator.clipboard.writeText(text)}>🗗</button>
        </div>
        <CodeBlock code={text} language={match?.[1] ?? 'text'} />
      </div>
    );
  },
};
import type { AgentEvent, AgentEventMessage, InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import {
  CodeBlock, DiffPanel, DiffView, FilesPanel, FileViewerPanel, Panel, PanelPicker, PlanPanel, SearchPanel,
  TasksPanel, TerminalPanel, ToolsPanel, PANEL_DEFS, type PanelId, type SearchHit,
} from './panels.js';
import { BRIDGE_COMMANDS, buildCommandList, runCommand, type CmdCtx, type CommandsCatalog, type DeskCommand, type SettingsSection } from './commands.js';
import { CommandPalette, SlashPopup, filterCommands } from './palette.js';
import { SettingsDialog, type ConfigSnapshot } from './settings.js';
import { installDevBridge } from './devBridge.js';
import { Icon } from './icons.js';

installDevBridge();

type PlanItem = { step: string; status: 'pending' | 'in_progress' | 'completed' };
type ToolItem = { id: number; tool: string; summary: string; preview?: string; ok: boolean; child?: string; file?: string };

/** Pull a workspace-relative path out of a tool summary ("Edited src/x.ts +3 -1"). */
function fileFromSummary(tool: string, summary: string): string | undefined {
  if (!/edit|write|patch|apply/i.test(tool)) return undefined;
  const m = summary.match(/[\w./-]+\.[\w]+/);
  return m?.[0];
}

type ChatRow =
  | { id: number; kind: 'user'; text: string; ts: number }
  | { id: number; kind: 'assistant'; text: string; ts: number }
  | { id: number; kind: 'status'; text: string; ts: number }
  | { id: number; kind: 'error'; text: string; detail?: string; ts: number }
  | { id: number; kind: 'cmd-out'; cmd: string; lines: string[]; ts: number }
  | { id: number; kind: 'loading'; ts: number }
  | { id: number; kind: 'tool-group'; items: ToolItem[]; ts: number };

function fmtAge(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtRel(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface SessionRow { sessionKey: string; firstUserMessage?: string; modifiedAt?: string }
interface FleetRow { kind: string; id: string; label: string }

let nextId = 0;
const rid = () => ++nextId;

const DEFAULT_WIDTHS: Partial<Record<PanelId, number>> = { file: 460, diff: 430, terminal: 420, files: 300 };
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];

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

function ToolGroup({ row, live, inlineDiffs, onRequestDiff }: {
  row: Extract<ChatRow, { kind: 'tool-group' }>;
  live?: boolean;
  inlineDiffs: Record<string, string>;
  onRequestDiff: (file: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [openItem, setOpenItem] = useState<number | null>(null);
  const [diffItem, setDiffItem] = useState<number | null>(null);
  // Observed: live groups read "Using {tool} *"; finished ones get an
  // outcome-phrased label ("Used N tools ›").
  const last = row.items[row.items.length - 1];
  const label = live
    ? `Using ${last.child ? `[${last.child}] ` : ''}${last.tool} ✶`
    : row.items.length === 1
      ? `${row.items[0].child ? `[${row.items[0].child}] ` : ''}${row.items[0].tool} — ${row.items[0].summary}`
      : `Used ${row.items.length} tools`;
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
                {t.file ? (
                  <span className="diff-chip" title="Inspect diff" onClick={(ev) => {
                    ev.stopPropagation();
                    if (diffItem === t.id) { setDiffItem(null); return; }
                    setDiffItem(t.id);
                    if (!inlineDiffs[t.file!]) onRequestDiff(t.file!);
                  }}>±{diffItem === t.id ? ' ⌄' : ''}</span>
                ) : null}
                {t.preview ? <span className="step-chevron">{openItem === t.id ? '⌄' : '›'}</span> : null}
              </button>
              {openItem === t.id && t.preview ? <pre className="tool-preview">{t.preview}</pre> : null}
              {diffItem === t.id && t.file ? (
                <div className="inline-diff">
                  {inlineDiffs[t.file] ? <DiffView diff={inlineDiffs[t.file]} /> : <div className="row status"><span className="spinner" /> Loading diff…</div>}
                </div>
              ) : null}
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
    <div className="panel-col" style={{ width, flexShrink: 1, minWidth: 250 }}>
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

/** DESK-4d — the greeting/home view shown on an empty session. */
function HomeView({ username, stats, tab, setTab, range, setRange, model, provider, repo, recents, onResume }: {
  username?: string;
  repo?: string;
  recents?: Array<{ sessionKey: string; firstUserMessage?: string; modifiedAt?: string }>;
  onResume?: (key: string) => void;
  stats: { sessions: number; turns: number; activeDays: number; currentStreak: number; longestStreak: number; model: string; perDay: Record<string, number> } | null;
  tab: 'overview' | 'models';
  setTab: (t: 'overview' | 'models') => void;
  range: 'all' | '30d' | '7d';
  setRange: (r: 'all' | '30d' | '7d') => void;
  model?: string;
  provider?: string;
}): React.ReactElement {
  const name = username ? username.charAt(0).toUpperCase() + username.slice(1) : 'there';
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 119;
  const cells: Array<{ day: string; n: number }> = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    cells.push({ day: key, n: stats?.perDay[key] ?? 0 });
  }
  const inRange = cells.filter((c) => c.n > 0);
  const turnsInRange = cells.reduce((s, c) => s + c.n, 0);
  const lvl = (n: number) => (n === 0 ? '' : n <= 2 ? ' h1' : n <= 5 ? ' h2' : ' h3');
  return (
    <div className="home">
      <div className="home-greet">
        <span className="spark">✺</span>
        <span>{repo ? `What should we build in ${repo}?` : `What's up next, ${name}?`}</span>
        <span className="whatsnew" onClick={() => sendReleaseNotes()}>What's new</span>
      </div>
      <div className="stats-card">
        <div className="stats-head">
          <div className="seg">
            <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
            <button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>Models</button>
          </div>
          <div className="seg">
            {(['all', '30d', '7d'] as const).map((r) => (
              <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>{r === 'all' ? 'All' : r}</button>
            ))}
          </div>
        </div>
        {tab === 'overview' ? (
          <>
            <div className="stat-grid">
              <div className="stat-card"><div className="stat-label">Sessions</div><div className="stat-value">{stats?.sessions ?? 0}</div></div>
              <div className="stat-card"><div className="stat-label">Turns</div><div className="stat-value">{range === 'all' ? stats?.turns ?? 0 : turnsInRange}</div></div>
              <div className="stat-card"><div className="stat-label">Active days</div><div className="stat-value">{range === 'all' ? stats?.activeDays ?? 0 : inRange.length}</div></div>
              <div className="stat-card"><div className="stat-label">Current streak</div><div className="stat-value">{stats?.currentStreak ?? 0}d</div></div>
              <div className="stat-card"><div className="stat-label">Longest streak</div><div className="stat-value">{stats?.longestStreak ?? 0}d</div></div>
              <div className="stat-card"><div className="stat-label">Model</div><div className="stat-value" style={{ fontSize: 13 }}>{stats?.model ?? model ?? '—'}</div></div>
              <div className="stat-card"><div className="stat-label">Provider</div><div className="stat-value" style={{ fontSize: 13 }}>{provider ?? '—'}</div></div>
              <div className="stat-card"><div className="stat-label">Workspace state</div><div className="stat-value" style={{ fontSize: 13 }}>shared w/ CLI</div></div>
            </div>
            <div className="heatmap" title="Turns per day">
              {cells.map((c) => <span key={c.day} className={`heat-cell${lvl(c.n)}`} title={`${c.day}: ${c.n}`} />)}
            </div>
          </>
        ) : (
          <div className="stat-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="stat-card"><div className="stat-label">Active model</div><div className="stat-value" style={{ fontSize: 14 }}>{model ?? '—'}</div></div>
            <div className="stat-card"><div className="stat-label">Provider</div><div className="stat-value" style={{ fontSize: 14 }}>{provider ?? '—'}</div></div>
          </div>
        )}
      </div>
      {recents && recents.length ? (
        <div className="home-recents">
          <div className="rail-section" style={{ margin: '0 0 6px' }}>Pick up where you left off</div>
          {recents.slice(0, 3).map((r) => (
            <button key={r.sessionKey} className="home-recent" onClick={() => onResume?.(r.sessionKey)}>
              <span className="session-dot" />
              <span className="hr-title">{r.firstUserMessage || r.sessionKey}</span>
              {r.modifiedAt ? <span className="session-age">{fmtAge(r.modifiedAt)}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function sendReleaseNotes(): void {
  window.brainrouter.send({ kind: 'query', id: 'q-recap', name: 'recap' });
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
  const [info, setInfo] = useState<{ sessionKey?: string; model?: string; workspaceRoot?: string; username?: string }>({});
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
  const [theme, setTheme] = useState(() => localStorage.getItem('br-desktop-theme') ?? 'dark');
  const [recentsSort, setRecentsSort] = useState<'recent' | 'alpha'>('recent');
  // DESK-4d² — composer popovers (one open at a time): mode · model · effort · account · export
  const [pop, setPop] = useState<'' | 'mode' | 'model' | 'effort' | 'account' | 'export' | 'branch'>('');
  const [homeStats, setHomeStats] = useState<{
    sessions: number; turns: number; activeDays: number; currentStreak: number;
    longestStreak: number; model: string; perDay: Record<string, number>;
  } | null>(null);
  const [statsTab, setStatsTab] = useState<'overview' | 'models'>('overview');
  const [statsRange, setStatsRange] = useState<'all' | '30d' | '7d'>('all');

  const liveBuf = useRef('');
  const lastPromptRef = useRef('');
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [turnStart, setTurnStart] = useState(0);
  const [nowTick, setNowTick] = useState(0);
  const [finishedTasks, setFinishedTasks] = useState<Array<{ id: string; label: string; status: string }>>([]);
  const [grepHits, setGrepHits] = useState<import('./panels.js').GrepHit[] | null>(null);
  const [inlineDiffs, setInlineDiffs] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<{ current: string | null; branches: string[] }>({ current: null, branches: [] });
  const [endpointModels, setEndpointModels] = useState<string[]>([]);
  const [chatWidth, setChatWidth] = useState(() => localStorage.getItem('br-chat-w') ?? 'medium');
  const [chatSize, setChatSize] = useState(() => localStorage.getItem('br-chat-fs') ?? 'medium');
  const [trustAsk, setTrustAsk] = useState<string | null>(null);
  const [accent, setAccent] = useState(() => localStorage.getItem('br-accent') ?? '');
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

  const pendingCmdRef = useRef('');
  function runBridge(cmd: string, argText = ''): void {
    pendingCmdRef.current = `/${cmd}${argText ? ` ${argText}` : ''}`;
    q('q-cmd', 'command:dispatch', { cmd, args: argText });
  }

  const cmdCtx: CmdCtx = {
    send: (c) => window.brainrouter.send(c as never),
    query: q,
    ensurePanel,
    openSettings,
    info: (title, body) => setInfoDialog({ title, body }),
    toast: setToast,
    compose: (text) => { setDraft(text); setSlashDismissed(true); },
    bridge: runBridge,
  };

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    document.documentElement.style.setProperty('--chat-w', chatWidth === 'narrow' ? '640px' : chatWidth === 'wide' ? '920px' : '760px');
    document.documentElement.style.setProperty('--chat-fs', chatSize === 'small' ? '12.5px' : chatSize === 'large' ? '14.5px' : '13.5px');
    localStorage.setItem('br-chat-w', chatWidth);
    localStorage.setItem('br-chat-fs', chatSize);
  }, [chatWidth, chatSize]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((p) => !p); }
      // View shortcuts (parity with the reference app's Views menu)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); togglePanel('diff'); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); togglePanel('files'); }
      if (e.ctrlKey && e.key === '`') { e.preventDefault(); togglePanel('terminal'); }
      if (mod && e.key === ',') { e.preventDefault(); openSettings('general'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--mono',
      codeFont.trim() ? `"${codeFont.trim()}", "SF Mono", Consolas, monospace` : '"SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace');
    localStorage.setItem('br-code-font', codeFont);
  }, [codeFont]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('br-desktop-theme', theme);
  }, [theme]);

  useEffect(() => {
    // Codex-style accent customization: one color drives accent + its soft tint.
    const root = document.documentElement.style;
    if (accent) {
      root.setProperty('--accent', accent);
      root.setProperty('--accent-soft', `${accent}21`);
    } else {
      root.removeProperty('--accent');
      root.removeProperty('--accent-soft');
    }
    localStorage.setItem('br-accent', accent);
  }, [accent]);

  // Narrow windows: the rail overlays content (CSS ≤1100px), so it starts
  // closed there and auto-closes when the window shrinks across the line.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)');
    if (mq.matches) setRailOpen(false);
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) setRailOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const push = (row: ChatRow) => setRows((r) => [...r, row]);
    const pushTool = (item: ToolItem) => setRows((r) => {
      const last = r[r.length - 1];
      if (last && last.kind === 'tool-group') {
        return [...r.slice(0, -1), { ...last, items: [...last.items, item] }];
      }
      return [...r, { id: rid(), kind: 'tool-group', items: [item], ts: Date.now() }];
    });
    const flushAssistant = () => {
      const text = liveBuf.current.trim();
      liveBuf.current = '';
      setLiveText('');
      if (text) push({ id: rid(), kind: 'assistant', text, ts: Date.now() });
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
          pushTool({ id: rid(), tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok, file: fileFromSummary(e.tool, e.summary) });
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
          push({ id: rid(), kind: 'status', text: `${e.status === 'completed' ? '✓' : '✗'} agent ${e.childId} (${e.role}) ${e.status}`, ts: Date.now() });
          setFinishedTasks((f) => [...f.slice(-30), { id: `${e.childId}-${Date.now()}`, label: `${e.role}·${e.childId.slice(-4)}`, status: e.status === 'completed' ? 'Agent · Completed' : 'Agent · Failed' }]);
          break;
        case 'plan-update':
          setLastPlan({ items: e.items, explanation: e.explanation });
          push({ id: rid(), kind: 'status', text: '☰ Updated the plan', ts: Date.now() });
          break;
        case 'compaction': push({ id: rid(), kind: 'status', text: `Compacted ${e.droppedMessages} → kept ${e.keptMessages}`, ts: Date.now() }); break;
        case 'memory': push({ id: rid(), kind: 'status', text: `${e.level === 'warn' ? '⚠ ' : ''}${e.text}`, ts: Date.now() }); break;
        case 'tokens-updated': setTokens({ promptTokens: e.promptTokens, completionTokens: e.completionTokens, turns: e.turns }); break;
        case 'interaction-request': setInteraction(e.request); setPicked([]); break;
        case 'session-changed':
          if (e.loadedMessages > 0) {
            // Observed: a centered spinner while the transcript loads, then
            // the full history renders scrolled to the bottom.
            setRows([{ id: rid(), kind: 'loading', ts: Date.now() }]);
            setSearchHits(null);
            q('q-transcript', 'transcript', { sessionKey: e.sessionKey });
          } else if (e.loadedMessages === 0) {
            setRows([{ id: rid(), kind: 'status', text: 'New chat started.', ts: Date.now() }]);
            setSearchHits(null);
          }
          setInfo((i) => ({ ...i, sessionKey: e.sessionKey, model: e.model || i.model }));
          refreshSidebar();
          break;
        case 'turn-complete': {
          flushAssistant();
          setRows((r) => (r.some((x) => x.kind === 'assistant') ? r : [...r, { id: rid(), kind: 'assistant', text: e.answer, ts: Date.now() }]));
          setRunning(false); setStatusLine(''); setReasoningTail('');
          refreshSidebar();
          break;
        }
        case 'turn-error':
          flushAssistant();
          push({ id: rid(), kind: 'error', text: 'Something went wrong', detail: e.message, ts: Date.now() });
          setRunning(false); setStatusLine(''); setReasoningTail('');
          // Observed: the app preserves your message on failure.
          setDraft((d) => d || lastPromptRef.current);
          break;
        case 'query-result': handleQueryResult(e.id, e.ok ? e.result : undefined, e.ok ? undefined : (e as { error?: string }).error); break;
        default: break;
      }
      // Sticky-bottom: never yank the view while the user is reading scrollback.
      queueMicrotask(() => { if (atBottomRef.current) chatEnd.current?.scrollIntoView({ behavior: 'auto' }); });
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
      case 'q-inline-diff': {
        const r = result as { path?: string; diff?: string };
        if (r?.path) setInlineDiffs((d) => ({ ...d, [r.path!]: r.diff ?? '' }));
        return;
      }
      case 'q-list': if (result && typeof result === 'object') setAllFiles((result as { files: string[] }).files ?? []); return;
      case 'q-read': if (result && typeof result === 'object') setFileView(result as { path: string; content: string }); return;
      case 'q-git': if (result && typeof result === 'object') setGitInfo(result as typeof gitInfo); return;
      case 'q-home': if (result && typeof result === 'object') setHomeStats(result as typeof homeStats); return;
      case 'q-branches': if (result && typeof result === 'object') setBranches(result as typeof branches); return;
      case 'q-models': if (result && typeof result === 'object') setEndpointModels(((result as { models?: string[] }).models ?? [])); return;
      case 'q-catalog': if (result && typeof result === 'object') setCatalog(result as CommandsCatalog); return;
      case 'q-snapshot': if (result && typeof result === 'object') setSnapshot(result as ConfigSnapshot); return;
      case 'q-usage': if (Array.isArray(result)) setUsageLines(result as string[]); return;
      case 'q-search': if (Array.isArray(result)) setSearchHits(result as SearchHit[]); return;
      case 'q-grep': if (Array.isArray(result)) setGrepHits(result as import('./panels.js').GrepHit[]); return;
      case 'q-transcript': {
        const data = result as { sessionKey?: string; rows?: Array<{ kind: string; text?: string; tools?: number }> };
        const mapped: ChatRow[] = (data?.rows ?? []).map((r) => {
          if (r.kind === 'user') return { id: rid(), kind: 'user' as const, text: r.text ?? '', ts: Date.now() };
          if (r.kind === 'assistant') return { id: rid(), kind: 'assistant' as const, text: r.text ?? '', ts: Date.now() };
          return { id: rid(), kind: 'status' as const, text: `⚙ Used ${r.tools ?? 0} tool${(r.tools ?? 0) === 1 ? '' : 's'}`, ts: Date.now() };
        });
        setRows([
          { id: rid(), kind: 'status', text: `Resumed ${data?.sessionKey ?? 'session'} — ${mapped.length} entries.`, ts: Date.now() },
          ...mapped,
        ]);
        atBottomRef.current = true;
        setAtBottom(true);
        setTimeout(() => chatEnd.current?.scrollIntoView({ behavior: 'auto' }), 50);
        return;
      }
      case 'q-cmd': {
        const lines = result && typeof result === 'object' && Array.isArray((result as { lines?: unknown }).lines)
          ? (result as { lines: string[] }).lines : [fmt(result)];
        setRows((r) => [...r, { id: rid(), kind: 'cmd-out', cmd: pendingCmdRef.current, lines, ts: Date.now() }]);
        return;
      }
      case 'a-allow-rule': setToast(`Always-allow rule saved${result && typeof result === 'object' && 'rule' in (result as object) ? `: ${(result as { rule: string }).rule}` : ''} — shared with the CLI.`); q('q-snapshot', 'config-snapshot'); return;
      case 'a-term': {
        const r = result as { out?: string; code?: number };
        setTermLines((l) => [...l.slice(-400), ...(r?.out ? r.out.split('\n') : []), r?.code ? `✗ exit ${r.code}` : '']);
        return;
      }
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
    q('q-home', 'home-stats');
    q('q-branches', 'git-branches');
  }

  function answerInteraction(response: { type: 'confirm'; approved: boolean } | { type: 'choice'; labels: string[] } | { type: 'dismissed' }): void {
    if (!interaction) return;
    window.brainrouter.send({ kind: 'interaction-response', id: interaction.id, response });
    setInteraction(null);
  }

  function submit(): void {
    const prompt = draft.trim();
    if (!prompt || running) return;
    // DESK-5 — bridge commands run against the CLI's stores, not as a turn.
    const bridgeMatch = prompt.match(/^\/([a-z-]+)(?:\s+([\s\S]+))?$/);
    if (bridgeMatch && BRIDGE_COMMANDS.has(bridgeMatch[1])) {
      setDraft('');
      runBridge(bridgeMatch[1], bridgeMatch[2] ?? '');
      return;
    }
    lastPromptRef.current = prompt;
    setRows((r) => [...r, { id: rid(), kind: 'user', text: prompt, ts: Date.now() }]);
    setDraft('');
    setRunning(true);
    setTurnStart(Date.now());
    window.brainrouter.send({ kind: 'start-turn', prompt });
  }

  const statuses = useMemo(() => new Map(changedFiles.map((f) => [f.path, f.status])), [changedFiles]);
  const sessionTitle = useMemo(() => {
    const firstUser = rows.find((r) => r.kind === 'user') as { text: string } | undefined;
    return firstUser ? firstUser.text.slice(0, 48) : 'New session';
  }, [rows]);

  // Observed stacking rule: a dock column holds up to two views stacked
  // vertically; further views open new columns.
  const panelPairs = useMemo(() => {
    const pairs: PanelId[][] = [];
    for (let i = 0; i < openPanels.length; i += 2) pairs.push(openPanels.slice(i, i + 2));
    return pairs;
  }, [openPanels]);

  const slashActive = !slashDismissed && !running && draft.startsWith('/') && !/\s/.test(draft);
  const slashMatches = useMemo(() => (slashActive ? filterCommands(commands, draft) : []), [slashActive, commands, draft]);

  // DESK-4d² — composer control state derived from the shared prefs.
  const prefsObj = snapshot?.prefs as Record<string, unknown> | undefined;
  const execMode = String(prefsObj?.executionMode ?? 'planning');
  const reviewPolicy = String(prefsObj?.reviewPolicy ?? 'request');
  const modeLabel = execMode === 'planning' ? 'Plan mode' : reviewPolicy === 'proceed' ? 'Auto mode' : 'Accept edits';
  const effort = String(prefsObj?.effort ?? 'medium');
  const modelChoices = useMemo(() => {
    const out = [info.model, snapshot?.fallbackModel].filter((m): m is string => !!m);
    return [...new Set(out)];
  }, [info.model, snapshot?.fallbackModel]);

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
      case 'files': return <Panel key={id} title={def.title} onClose={close}><FilesPanel files={allFiles} statuses={statuses} onOpen={openFile} grepHits={grepHits} onGrep={(gq) => q('q-grep', 'search-content', { q: gq })} /></Panel>;
      case 'file': return <Panel key={id} title={fileView?.path ? `File — ${fileView.path.split('/').pop()}` : def.title} onClose={close}><FileViewerPanel view={fileView} /></Panel>;
      case 'diff': return (
        <Panel key={id} title={def.title} onClose={close}>
          <DiffPanel gitInfo={gitInfo} changed={changedFiles} diff={diffView}
            onPick={(p) => q('q-diff', 'file-diff', { path: p })}
            onBack={() => setDiffView(null)} onOpenFile={openFile} />
        </Panel>);
      case 'terminal': return <Panel key={id} title={def.title} onClose={close}><TerminalPanel /></Panel>;
      case 'tools': return <Panel key={id} title={def.title} onClose={close}><ToolsPanel log={toolLog} /></Panel>;
      case 'tasks': return <Panel key={id} title={def.title} onClose={close}><TasksPanel fleet={fleet} finished={finishedTasks} onClear={() => setFinishedTasks([])} /></Panel>;
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
            <button className="icon-btn" title="Toggle sidebar" onClick={() => setRailOpen(false)}><Icon name="layout" size={15} /></button>
            <button className="icon-btn" title="Search commands (⌘K)" onClick={() => setPaletteOpen(true)}><Icon name="search" size={14} /></button>
          </div>
          <div className="rail-card">
          <button className="rail-row primary" onClick={() => window.brainrouter.send({ kind: 'new-session' })}><span className="ri"><Icon name="plus" size={14} /></span>New session</button>
          <button className="rail-row" onClick={() => setPaletteOpen(true)}><span className="ri"><Icon name="command" size={14} /></span>Commands<span className="rail-hint">⌘K</span></button>
          <button className="rail-row" onClick={() => void window.brainrouter.addWorkspace()}><span className="ri"><Icon name="folder" size={14} /></span>Add workspace…</button>
          {workspaces.recents.filter((w) => w !== workspaces.current).slice(0, 3).map((w) => (
            <button key={w} className="rail-row" title={w} onClick={() => {
              const trusted: string[] = JSON.parse(localStorage.getItem('br-trusted') ?? '[]');
              if (trusted.includes(w)) void window.brainrouter.openWorkspace(w);
              else setTrustAsk(w);
            }}><span className="ri"><Icon name="chev-right" size={11} /></span>{w.split('/').pop()}</button>
          ))}
          <div className="recents-head">
            <span className="rail-section" style={{ margin: 0 }}>Recents</span>
            <button className="icon-btn" title={`Sort: ${recentsSort}`} onClick={() => setRecentsSort((s) => (s === 'recent' ? 'alpha' : 'recent'))}><Icon name="sort" size={13} /></button>
          </div>
          <div className="rail-scroll">
            {(recentsSort === 'alpha'
              ? [...sessions].sort((a, b) => (a.firstUserMessage ?? a.sessionKey).localeCompare(b.firstUserMessage ?? b.sessionKey))
              : sessions
            ).map((s) => (
              <div key={s.sessionKey} className={`session${s.sessionKey === info.sessionKey ? ' active' : ''}`} title={s.sessionKey}
                   onClick={() => window.brainrouter.send({ kind: 'resume-session', sessionKey: s.sessionKey })}>
                <span className="session-dot" style={running && s.sessionKey === info.sessionKey ? { background: 'var(--brand)' } : undefined} /><span>{s.firstUserMessage || s.sessionKey}</span>
                {s.modifiedAt ? <span className="session-age">{fmtAge(s.modifiedAt)}</span> : null}
              </div>
            ))}
          </div>
          <div className="pop-wrap">
            {pop === 'account' ? (
              <div className="menu-pop left" style={{ minWidth: 230 }}>
                <div className="menu-head"><span>{info.username ?? 'BrainRouter'} · {workspaces.current?.split('/').pop() ?? 'workspace'}</span></div>
                <button className="menu-item" onClick={() => { setPop(''); openSettings('general'); }}><span className="mi-check" />Settings<span className="mi-hint">⌃,</span></button>
                <button className="menu-item" onClick={() => { setPop(''); openSettings('commands'); }}><span className="mi-check" />All commands</button>
                <button className="menu-item" onClick={() => { setPop(''); setInfoDialog({ title: 'About BrainRouter Desktop', body: `Workspace: ${info.workspaceRoot ?? '—'}\nSession: ${info.sessionKey ?? '—'}\nModel: ${info.model ?? '—'}\n\nState is shared with the brainrouter CLI — same config.json, same sessions, same brain.` }); }}><span className="mi-check" />About</button>
              </div>
            ) : null}
            <div className="account-row" onClick={() => setPop(pop === 'account' ? '' : 'account')} title="Account">
              <span className="avatar">{(info.username ?? 'br').slice(0, 2)}</span>
              <span className="account-name">{info.username ?? 'BrainRouter'} <span className="account-sub">· {workspaces.current?.split('/').pop() ?? 'workspace'}</span></span>
              <span className="account-chev"><Icon name="chev-down" size={12} /></span>
            </div>
          </div>
          </div>
        </nav>
      ) : null}

      <div className="main">
        <div className="workrow">
          <main className="center">
            <header className="chat-head">
              {!railOpen ? <button className="icon-btn" title="Open sidebar" onClick={() => setRailOpen(true)}><Icon name="layout" size={15} /></button> : null}
              <span className="crumb"><b>{gitInfo?.repo ?? info.workspaceRoot?.split('/').pop() ?? 'BrainRouter'}</b><span className="crumb-sep">/</span>{sessionTitle}</span>
              <span className="topbar-right">
                {gitInfo?.branch ? <span className="chip dim chip-ic" title="branch"><Icon name="branch" size={11} /> {gitInfo.branch}</span> : null}
                <button className="icon-btn" title="Export session" onClick={() => setPop(pop === 'export' ? '' : 'export')}><Icon name="export" size={14} /></button>
                <PanelPicker open={openPanels} onToggle={togglePanel} />
                <button className="icon-btn" title="Settings" onClick={() => openSettings('general')}><Icon name="gear" size={14} /></button>
              </span>
            </header>
            <div className="chat" ref={chatRef} onScroll={() => {
              const el = chatRef.current;
              if (!el) return;
              const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              atBottomRef.current = pinned;
              setAtBottom(pinned);
            }}>
              {rows.length === 0 && !liveText && !running ? (
                <HomeView username={info.username} stats={homeStats} tab={statsTab} setTab={setStatsTab}
                  range={statsRange} setRange={setStatsRange} model={info.model} provider={snapshot?.provider}
                  repo={gitInfo?.repo ?? info.workspaceRoot?.split('/').pop()}
                  recents={sessions}
                  onResume={(key) => window.brainrouter.send({ kind: 'resume-session', sessionKey: key })} />
              ) : null}
              {rows.map((r, i) => {
                switch (r.kind) {
                  case 'user': return (
                    <div key={r.id} className="row user-row">
                      <div className="user">{r.text}</div>
                      <span className="msg-actions">
                        <button className="icon-btn" title="Copy" onClick={() => void navigator.clipboard.writeText(r.text)}><Icon name="copy" size={11} /></button>
                        <span>{fmtRel(r.ts)}</span>
                      </span>
                    </div>
                  );
                  case 'assistant': return (
                    <div key={r.id} className="row assistant md">
                      <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{r.text}</Markdown>
                      <div className="turn-mark">✺</div>
                      <span className="msg-actions">
                        <button className="icon-btn" title="Copy" onClick={() => void navigator.clipboard.writeText(r.text)}><Icon name="copy" size={11} /></button>
                        <span>{fmtRel(r.ts)}</span>
                      </span>
                    </div>
                  );
                  case 'tool-group': return <div key={r.id} className="row"><ToolGroup row={r} live={running && i === rows.length - 1 && !liveText} inlineDiffs={inlineDiffs} onRequestDiff={(f) => q('q-inline-diff', 'file-diff', { path: f })} /></div>;
                  case 'error': return (
                    <div key={r.id} className="row">
                      <div className="error-card">
                        <button className="icon-btn err-x" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>✕</button>
                        <span className="error-icon"><Icon name="warn" size={15} /></span>
                        <div className="error-title">{r.text}</div>
                        <div className="error-advice">Try sending your message again — your draft was kept. If it keeps happening, check the host log.</div>
                        {r.detail ? <div className="error-detail">{r.detail}</div> : null}
                      </div>
                    </div>
                  );
                  case 'loading': return (
                    <div key={r.id} className="row history-loading"><span className="spinner big" /></div>
                  );
                  case 'cmd-out': return (
                    <div key={r.id} className="row">
                      <div className="cmd-out">
                        <div className="cmd-out-head">{r.cmd}</div>
                        <pre>{r.lines.join('\n')}</pre>
                      </div>
                    </div>
                  );
                  case 'status': return <div key={r.id} className="row status">{r.text}</div>;
                }
              })}
              {liveText ? (
                <div className="row assistant md live">
                  <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{liveText}</Markdown>
                  <span className="caret">▍</span>
                </div>
              ) : null}
              {running ? (
                <div className="row workline">
                  <span className="spark">✺</span>
                  <span>{Math.max(0, Math.floor(((nowTick || Date.now()) - turnStart) / 1000))}s</span>
                  <span>·</span>
                  <span>{liveText ? 'writing…' : reasoningTail ? 'thinking…' : statusLine || 'working…'}</span>
                  {reasoningTail && !liveText ? <span className="reasoning"> {reasoningTail.slice(-90)}</span> : null}
                </div>
              ) : null}
              {interaction && interaction.type === 'confirm' ? (
                <div className="approval-card" onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) answerInteraction({ type: 'confirm', approved: true });
                }}>
                  <div className="approval-head">
                    <span className="approval-dot" />
                    <span className="approval-title">{interaction.title}</span>
                    <span className="approval-scope">Project (local)</span>
                  </div>
                  {interaction.tool ? <div className="approval-sub">{interaction.tool}</div> : null}
                  {interaction.dangerous ? <div className="approval-warn">This action is flagged as potentially dangerous.</div> : null}
                  {interaction.detail ? <pre className="approval-detail">{interaction.detail}</pre> : null}
                  <div className="approval-actions">
                    <button className="btn-deny" onClick={() => answerInteraction({ type: 'confirm', approved: false })}>Deny</button>
                    <span className="spacer" />
                    <button className="btn-always" onClick={() => {
                      const rule = `${interaction.tool ?? 'run_command'}(*)`;
                      q('a-allow-rule', 'action:allow-rule', { rule });
                      answerInteraction({ type: 'confirm', approved: true });
                    }}>Always allow</button>
                    <button className="btn-once" autoFocus onClick={() => answerInteraction({ type: 'confirm', approved: true })}>Allow once<kbd>Ctrl+⏎</kbd></button>
                  </div>
                </div>
              ) : null}
              <div ref={chatEnd} />
            </div>
            {!atBottom ? (
              <button className="jump-latest" onClick={() => {
                atBottomRef.current = true;
                setAtBottom(true);
                chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
              }}>↓ Latest</button>
            ) : null}
            {gitInfo?.branch && (gitInfo.insertions + gitInfo.deletions > 0) ? (
              <div className="branchbar" onClick={() => ensurePanel('diff')}>
                <span className="gitbranch">⎇ {gitInfo.branch}</span>
                <span><span className="add-n">+{gitInfo.insertions.toLocaleString()}</span> <span className="del-n">-{gitInfo.deletions.toLocaleString()}</span></span>
                <span className="dim">{changedFiles.length} files — click for diff</span>
              </div>
            ) : null}
            <div className="composer">
              {rows.length === 0 && !running ? (
                <div className="ws-chips">
                  <button className="ws-chip" title={info.workspaceRoot}><Icon name="monitor" size={12} /> {info.workspaceRoot?.split('/').pop() ?? 'Local'}</button>
                  <button className="ws-chip" onClick={() => void window.brainrouter.addWorkspace()}><Icon name="folder" size={12} /> Select folder…</button>
                </div>
              ) : null}
              <div className="box">
                {slashActive && slashMatches.length ? (
                  <div className="slash-pop">
                    <SlashPopup commands={commands} filter={draft} selected={slashSel} onPick={runSlash} onHover={setSlashSel} />
                  </div>
                ) : null}
                <textarea
                  rows={1}
                  placeholder={running ? 'Working…' : 'Message BrainRouter…  ( / for commands )'}
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
                <button className={`input-send icon-btn${running ? ' stop-red' : ''}`} title={running ? 'Stop' : 'Send'}
                  onClick={() => running ? window.brainrouter.send({ kind: 'interrupt' }) : submit()}
                  disabled={!running && !draft.trim()}>{running ? <Icon name="stop" size={14} /> : <Icon name="arrow-up" size={14} />}</button>
              </div>
                <div className="context-chips">
                <span className="ctx-chip" title={info.workspaceRoot}><Icon name="folder" size={11} /> {info.workspaceRoot?.split('/').pop() ?? 'workspace'}</span>
                <span className="pop-wrap">
                  {pop === 'branch' ? (
                    <div className="menu-pop left" style={{ bottom: 'calc(100% + 8px)' }}>
                      <div className="menu-head"><span>Branches</span></div>
                      {branches.branches.slice(0, 12).map((b) => (
                        <button key={b} className="menu-item" onClick={() => {
                          setPop('');
                          if (b === branches.current) return;
                          setTermLines((l) => [...l.slice(-400), `❯ git checkout ${b}`]);
                          q('a-term', 'action:term-exec', { cmd: `git checkout ${JSON.stringify(b).slice(1, -1)}` });
                          setTimeout(() => { q('q-branches', 'git-branches'); q('q-git', 'git-info'); }, 600);
                        }}>
                          <span className="mi-check">{b === branches.current ? '✓' : ''}</span>{b}
                        </button>
                      ))}
                      {branches.branches.length === 0 ? <div className="empty">Not a git repository.</div> : null}
                    </div>
                  ) : null}
                  {branches.current ? (
                    <span className="ctx-chip" onClick={() => setPop(pop === 'branch' ? '' : 'branch')}><Icon name="branch" size={11} /> {branches.current} <Icon name="chev-down" size={9} /></span>
                  ) : null}
                </span>
              </div>
              <div className="composer-controls">
                  <span className="pop-wrap">
                    {pop === 'mode' ? (
                      <div className="menu-pop left">
                        <div className="menu-head"><span>Mode</span><span>⇧⌃M</span></div>
                        {([['Plan mode', 'planning', 'request', '1'], ['Accept edits', 'fast', 'request', '2'], ['Auto mode', 'fast', 'proceed', '3']] as const).map(([label, em, rp, num]) => (
                          <button key={label} className="menu-item" onClick={() => {
                            q('a-pref', 'action:set-pref', { key: 'executionMode', value: em });
                            q('a-pref', 'action:set-pref', { key: 'reviewPolicy', value: rp });
                            setPop('');
                          }}>
                            <span className="mi-check">{modeLabel === label ? '✓' : ''}</span>{label}
                            <span className="mi-hint">{num}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <span className="chip dim" onClick={() => setPop(pop === 'mode' ? '' : 'mode')}>{modeLabel} ⌄</span>
                  </span>
                  <span className="composer-spacer" />
                  <span className="pop-wrap">
                    {pop === 'model' ? (
                      <div className="menu-pop model-menu">
                        <div className="menu-head"><span>Reasoning</span></div>
                        {EFFORT_LEVELS.map((lvl) => (
                          <button key={lvl} className="menu-item" onClick={() => q('a-pref', 'action:set-pref', { key: 'effort', value: lvl })}>
                            <span className="mi-check">{effort === lvl ? '✓' : ''}</span>{lvl === 'xhigh' ? 'Extra high' : lvl[0].toUpperCase() + lvl.slice(1)}
                          </button>
                        ))}
                        <div className="menu-sep" />
                        <div className="menu-head"><span>Models{endpointModels.length ? ` · ${endpointModels.length} on endpoint` : ''}</span><span>⇧⌃I</span></div>
                        <div className="model-list">
                        {(endpointModels.length ? endpointModels : modelChoices).map((m, i) => (
                          <button key={m} className="menu-item" onClick={() => {
                            window.brainrouter.send({ kind: 'set-model', model: m, persist: true });
                            setPop('');
                          }}>
                            <span className="mi-check">{m === info.model ? '✓' : ''}</span>{m}
                            <span className="mi-hint">{i < 9 ? i + 1 : ''}</span>
                          </button>
                        ))}
                        </div>
                        <button className="menu-item" onClick={() => { setPop(''); openSettings('general'); }}>
                          <span className="mi-check" />Custom model…
                        </button>
                        <div className="menu-sep" />
                        <div className="menu-row">
                          <span>Fast mode</span>
                          <button className={`switch${execMode === 'fast' ? ' on' : ''}`} onClick={() => {
                            q('a-pref', 'action:set-pref', { key: 'executionMode', value: execMode === 'fast' ? 'planning' : 'fast' });
                          }} />
                        </div>
                      </div>
                    ) : null}
                    <span className="dim model-label" style={{ cursor: 'pointer' }} onClick={() => { if (pop !== 'model') q('q-models', 'list-models'); setPop(pop === 'model' ? '' : 'model'); }}>{info.model ?? ''} · {effort}</span>
                  </span>
                  <span className={`orb${running ? ' busy' : ''}`} title={running ? 'Working' : 'Idle'} />
                </div>
            </div>
          </main>

          {panelPairs.map((pair) => (
            <PanelColumn key={pair.join('+')} width={panelWidths[pair[0]] ?? DEFAULT_WIDTHS[pair[0]] ?? 360}
              onWidth={(w) => setPanelWidths((pw) => ({ ...pw, [pair[0]]: w }))}>
              <div className="col-stack">
                {pair.map((id) => renderPanel(id))}
              </div>
            </PanelColumn>
          ))}
        </div>
      </div>

      {pop && pop !== 'export' ? <div className="picker-backdrop" onClick={() => setPop('')} /> : null}

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
        theme={theme}
        onTheme={setTheme}
        chatWidth={chatWidth}
        onChatWidth={setChatWidth}
        chatSize={chatSize}
        onChatSize={setChatSize}
        accent={accent}
        onAccent={setAccent}
      />

      {interaction && interaction.type === 'choice' ? (
        <div className="overlay" onKeyDown={(e) => {
          if (e.key === 'Escape') answerInteraction({ type: 'dismissed' });
        }} tabIndex={-1} ref={(el) => el?.focus()}>
          <div className="dialog">
            {(
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

      {trustAsk ? (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setTrustAsk(null); }}>
          <div className="dialog" style={{ width: 460 }}>
            <div className="dialog-title">Trust this workspace?</div>
            <div className="set-desc" style={{ marginBottom: 10 }}>BrainRouter may read, write, or execute files in this directory. Only proceed if you trust this workspace.</div>
            <pre className="dialog-detail">{trustAsk}</pre>
            <div className="dialog-actions">
              <button className="deny" onClick={() => setTrustAsk(null)}>Cancel</button>
              <button className="approve" onClick={() => {
                const trusted: string[] = JSON.parse(localStorage.getItem('br-trusted') ?? '[]');
                localStorage.setItem('br-trusted', JSON.stringify([...new Set([...trusted, trustAsk])]));
                void window.brainrouter.openWorkspace(trustAsk);
                setTrustAsk(null);
              }}>Trust workspace</button>
            </div>
          </div>
        </div>
      ) : null}

      {pop === 'export' ? (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setPop(''); }}>
          <div className="dialog" style={{ width: 420 }}>
            <div className="dialog-title">Export session</div>
            <div className="set-desc" style={{ marginBottom: 12 }}>Save this session's transcript to a file — same as /export-chat in the CLI.</div>
            <div className="dialog-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="approve" onClick={() => { q('q-export', 'export-chat', { format: 'md' }); setPop(''); }}>Markdown</button>
              <button className="deny" onClick={() => { q('q-export', 'export-chat', { format: 'json' }); setPop(''); }}>JSON</button>
            </div>
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
