/**
 * DESK-4c — the app shell: left rail · chat thread · resizable panel columns.
 * Panels open as full-height window columns right of the chat (drag the left
 * edge to resize). Every CLI slash command surfaces here: ⌘K palette, the
 * composer "/" popup, and the categorized Settings modal.
 */
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
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
          <button className="icon-btn" title="Copy" onClick={() => void navigator.clipboard.writeText(text)}><Icon name="copy" size={12} /></button>
        </div>
        <CodeBlock code={text} language={match?.[1] ?? 'text'} />
      </div>
    );
  },
};
import type { AgentEvent, AgentEventMessage, InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import {
  CodeBlock, DiffPanel, DiffView, FilesPanel, FileViewerPanel, PlanPanel, SearchPanel,
  TasksPanel, TerminalPanel, ToolsPanel, PANEL_DEFS, type PanelId, type SearchHit,
} from './panels.js';
import { buildCommandList, runCommand, resolveSlashInput, type CmdCtx, type CommandsCatalog, type DeskCommand, type SettingsSection } from './commands.js';
import { CommandPalette, SlashPopup, filterCommands } from './palette.js';
import { SettingsDialog, type ConfigSnapshot } from './settings.js';
import { installDevBridge } from './devBridge.js';
import { Icon } from './icons.js';

installDevBridge();

type PlanItem = { step: string; status: 'pending' | 'in_progress' | 'completed'; acceptance?: string };
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

interface SessionRow { sessionKey: string; firstUserMessage?: string; modifiedAt?: string; turnCount?: number; lastRole?: string;
  // DESK-6m — UI metadata from sessionMetaStore, merged in by list-sessions.
  pinned?: boolean; archived?: boolean; status?: 'active' | 'completed'; group?: string | null;
  // DESK-6u — parent session key this chat was forked from (null = not a fork).
  forkedFrom?: string | null }
// Mirrors the CLI's BackgroundTask (runtime/backgroundTasks.ts): the fleet is
// sub-agents · workers · workflows, with start time and worktree isolation.
interface FleetRow { kind: string; id: string; label: string; startedAt?: string; role?: string; worktree?: boolean; parentSessionKey?: string | null }

function fmtElapsed(iso?: string): string {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/**
 * DESK-5d — Codex/Claude-style session status icons. All real signal:
 * spinner = a turn is running here right now; amber dot = the transcript
 * ends on a user message (interrupted — waiting on a reply); hollow ring =
 * a normally-completed chat.
 */
function SessionStatus({ s, working }: { s: SessionRow; working?: boolean }): React.ReactElement {
  if (working) return <span className="st"><span className="spinner sm" /></span>;
  if (s.lastRole === 'user') return <span className="st st-dot warn" title="Interrupted — waiting for your reply" />;
  return <span className="st st-ring" title={s.turnCount ? `${s.turnCount} entries` : undefined} />;
}

// DESK-5w (#4 lag) — the turn's elapsed-seconds ticker, isolated into its own
// component with its own 1s interval. Previously a top-level `nowTick` state
// re-rendered the ENTIRE App every second; now only this tiny node updates.
function WorkElapsed({ startedAt }: { startedAt: number }): React.ReactElement {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(force, 1000);
    return () => clearInterval(t);
  }, []);
  return <span>{Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s</span>;
}

// DESK-6w — a workflow run's full breakdown, mirroring Claude Code's /workflows
// card: phases, each with the child agents it spawned and their token/tool/time.
interface WorkflowAgent { id: string; label: string; role: string; status: string; tokens: number; tools: number; ms: number }
interface WorkflowPhase { id: string; title: string; status: string; agents: WorkflowAgent[] }
interface WorkflowDetail {
  slug: string; kind: string; status: string; startedAt: string; updatedAt: string;
  totalAgents: number; totalTokens: number;
  phases: WorkflowPhase[];
  steps: Array<{ id: string; title: string; status: string }>;
}
const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
};
/** Status → the dot/badge modifier class shared by phases + agents. */
const wfStatusClass = (status: string): string => {
  if (status === 'completed' || status === 'done') return 'done';
  if (status === 'running' || status === 'pending') return 'run';
  if (status === 'failed') return 'fail';
  if (status === 'partial' || status === 'interrupted' || status === 'stale') return 'warn';
  return '';
};

// DESK-6w — the /workflows-style card. Header (kind·slug + status + elapsed +
// totals), then one section per phase: title, a progress-dot strip (one dot per
// agent, colored by that agent's status), and an Agent | Tokens | Tools | Time table.
function WorkflowCard({ wf, onBack }: { wf: WorkflowDetail; onBack: () => void }): React.ReactElement {
  const started = new Date(wf.startedAt).getTime();
  const live = wf.status === 'running';
  return (
    <div className="wf-card">
      <div className="wf-head">
        <button className="task-back" onClick={onBack}>← Back</button>
        <span className="wf-title">{wf.kind ? `${wf.kind} · ` : ''}{wf.slug}</span>
        <span className={`task-status ${wfStatusClass(wf.status)}`}>{wf.status}</span>
        <span className="wf-elapsed">{live ? <WorkElapsed startedAt={started} /> : fmtDur(new Date(wf.updatedAt).getTime() - started)}</span>
      </div>
      <div className="wf-meta">
        <span><b>{wf.totalAgents}</b> agent{wf.totalAgents === 1 ? '' : 's'}</span>
        <span className="dim">·</span>
        <span><b>{fmtTokens(wf.totalTokens)}</b> tokens</span>
      </div>
      {wf.phases.length === 0 && wf.steps.length > 0 ? (
        <div className="wf-phase">
          <div className="wf-phase-head"><span className="wf-phase-title">Steps</span></div>
          {wf.steps.map((st) => (
            <div key={st.id} className="wf-step"><span className={`wf-dot ${wfStatusClass(st.status)}`} /><span>{st.title}</span><span className="wf-step-status dim">{st.status}</span></div>
          ))}
        </div>
      ) : null}
      {wf.phases.map((p) => (
        <div key={p.id} className="wf-phase">
          <div className="wf-phase-head">
            <span className="wf-phase-title">{p.title}</span>
            <span className={`task-status ${wfStatusClass(p.status)}`}>{p.status}</span>
            <span className="wf-dots">{p.agents.map((a) => <span key={a.id} className={`wf-dot ${wfStatusClass(a.status)}`} title={`${a.label} — ${a.status}`} />)}</span>
          </div>
          {p.agents.length > 0 ? (
            <div className="wf-table">
              <div className="wf-row wf-row-head"><span>Agent</span><span>Tokens</span><span>Tools</span><span>Time</span></div>
              {p.agents.map((a) => (
                <div key={a.id} className="wf-row" title={`${a.role} · ${a.status}`}>
                  <span className="wf-agent"><span className={`wf-dot ${wfStatusClass(a.status)}`} />{a.label}</span>
                  <span>{fmtTokens(a.tokens)}</span>
                  <span>{a.tools}</span>
                  <span>{fmtDur(a.ms)}</span>
                </div>
              ))}
            </div>
          ) : <div className="wf-empty dim">No agents in this phase yet.</div>}
        </div>
      ))}
    </div>
  );
}

let nextId = 0;
const rid = () => ++nextId;

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];

/**
 * DESK-5l — endpoints (LM Studio/Ollama/OpenAI) list EVERY model they serve,
 * including embedding/audio/rerank models that cannot hold a chat. Picking
 * one breaks the session ("model returned an empty response"), so the chat
 * picker hides them; Settings → Custom model… remains the escape hatch.
 */
const NON_CHAT_MODEL = /embed|whisper|tts|rerank|moderation|audio|clip/i;

/**
 * DESK-5f — view catalog for the tabbed side panel + bottom dock "+" menus.
 * One view = one tab; both surfaces switch tabs instead of opening windows.
 */
const VIEW_MENU: Array<{ id: PanelId; title: string; icon: string }> = [
  { id: 'plan', title: 'Plan', icon: 'review' },
  { id: 'files', title: 'Files', icon: 'folder' },
  { id: 'diff', title: 'Changes', icon: 'diff' },
  { id: 'tasks', title: 'Background tasks', icon: 'tasks' },
  { id: 'tools', title: 'Tool calls', icon: 'bolt' },
  { id: 'search', title: 'Search session', icon: 'search' },
  { id: 'context', title: 'Context', icon: 'layout-right' },
];

/**
 * DESK-5f — animated presence: keeps a surface mounted through its exit
 * animation. `closing` drives a `.closing` class whose keyframes reverse the
 * entry animation; the node unmounts when they finish.
 */
function useClosable(open: boolean, ms = 170): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) { setMounted(true); setClosing(false); return; }
    setClosing(true);
    const t = setTimeout(() => { setMounted(false); setClosing(false); }, ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: mounted || open, closing };
}
const VALID_PANEL_IDS = new Set<PanelId>(PANEL_DEFS.map((p) => p.id));

// DESK-5v — CONCURRENT SESSIONS: events that only make sense for the chat ON
// SCREEN. When one arrives tagged with a BACKGROUND session (a turn still
// running in a chat you switched away from), it's dropped so it can't pollute
// the viewed chat. The turn lifecycle + session-changed + query-result +
// approval events are NOT in here — they're handled session-aware so a
// background turn still updates its spinner and lands its result/error.
const FOREGROUND_ONLY_KINDS = new Set<string>([
  'status', 'reasoning-delta', 'assistant-turn-start', 'assistant-delta',
  'assistant-turn-end', 'tool-end', 'child-tool-start', 'child-tool-end',
  'child-complete', 'plan-update', 'compaction', 'memory', 'tokens-updated',
]);

function devSearchParams(): URLSearchParams | null {
  return import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
}

function devFlag(name: string): boolean {
  const value = devSearchParams()?.get(name);
  return value === '1' || value === 'true';
}

function devPanels(): PanelId[] {
  const raw = devSearchParams()?.get('panels');
  if (!raw) return [];
  return raw.split(',')
    .map((p) => p.trim())
    .filter((p): p is PanelId => VALID_PANEL_IDS.has(p as PanelId) && p !== 'terminal');
}

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
  // DESK-6t — collapsed multi-tool groups list the DISTINCT tool names so you
  // can see what the step was about at a glance, instead of a bare "Used N tools".
  const toolNames = [...new Set(row.items.map((i) => i.tool))];
  const namesLabel = toolNames.slice(0, 4).join(' · ') + (toolNames.length > 4 ? ` +${toolNames.length - 4}` : '');
  const label = live
    ? `Using ${last.child ? `[${last.child}] ` : ''}${last.tool} ✶`
    : row.items.length === 1
      ? `${row.items[0].child ? `[${row.items[0].child}] ` : ''}${row.items[0].tool} — ${row.items[0].summary}`
      : `${row.items.length} tools · ${namesLabel}`;
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
              <div className="stat-card"><div className="stat-label">Streak</div><div className="stat-value">{stats?.currentStreak ?? 0}d <span className="stat-sub">· best {stats?.longestStreak ?? 0}d</span></div></div>
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

/**
 * DESK-5q/5r — the composer's context ring: an arc filled by how full the
 * session's context is RELATIVE to the auto-compact threshold — the point
 * where BrainRouter summarizes old history and the context resets. It grows
 * live as a turn accumulates context and drops after a compaction. A small %
 * readout sits beside it so it's legible even at a glance; the tooltip carries
 * the exact tokens, the compact point, and the model window.
 */
function ContextRing({ usage }: { usage: { used: number; window: number; compactAt: number; limit: number; pct: number } | null }): React.ReactElement {
  const r = 7, circ = 2 * Math.PI * r;
  const pct = usage && usage.limit > 0 ? Math.max(0, Math.min(1, usage.pct)) : 0;
  const tone = pct >= 0.95 ? 'var(--err)' : pct >= 0.75 ? 'var(--warn)' : 'var(--accent)';
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const title = usage && usage.used > 0
    ? `Context ${Math.round(pct * 100)}% — ${usage.used.toLocaleString()} tokens` +
      `\nAuto-compacts above ~${usage.compactAt.toLocaleString()} (old history is summarized, context resets)` +
      (usage.window > 0 ? `\nModel window: ${usage.window.toLocaleString()}` : '')
    : 'Context fill — grows as the chat accumulates, resets when it auto-compacts';
  return (
    <span className="ctx-ring" title={title}>
      <svg width="16" height="16" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={r} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="2.4" />
        <circle cx="9" cy="9" r={r} fill="none" stroke={tone} strokeWidth="2.4" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} transform="rotate(-90 9 9)" />
      </svg>
      {usage && usage.used > 0 ? <span className="ctx-pct">{Math.round(pct * 100)}%</span> : null}
    </span>
  );
}

/** Compact token count: 1234 → "1.2k", 1_000_000 → "1.0M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/** DESK-5s — one labeled progress bar for the context/usage popover. */
function UsageBar({ label, value, total, suffix, tone = 'var(--accent)' }: {
  label: string; value: number; total: number; suffix?: string; tone?: string;
}): React.ReactElement {
  const pct = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  return (
    <div className="usage-row">
      <div className="usage-row-top">
        <span className="usage-label">{label}</span>
        <span className="usage-val">{total > 0 ? `${fmtTokens(value)} / ${fmtTokens(total)} (${Math.round(pct * 100)}%)` : (suffix ?? '—')}</span>
      </div>
      <div className="usage-track"><span className="usage-fill" style={{ width: `${pct * 100}%`, background: tone }} /></div>
    </div>
  );
}

function sendReleaseNotes(): void {
  window.brainrouter.send({ kind: 'query', id: 'q-recap', name: 'recap' });
}

export function App(): React.ReactElement {
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [draft, setDraft] = useState('');
  // `running` = the VIEWED session has a turn in flight (drives the composer).
  const [running, setRunning] = useState(false);
  // DESK-6 — Stop was pressed and we're waiting for the turn to actually unwind.
  // Gives immediate visual feedback (the old code only fired IPC and showed a
  // volatile status line that the next 'Thinking…' overwrote). Cleared when the
  // turn really ends (turn-complete/turn-error) or on a session switch.
  const [stopping, setStopping] = useState(false);
  // DESK-5v — CONCURRENT SESSIONS: every session key with a turn in flight, so
  // switching away never stops a turn and the sidebar shows a spinner on each
  // chat that's still working. `running` above is just "is the viewed one in
  // this set". Ref mirror so the persistent onEvent listener reads live state.
  const runningSessionsRef = useRef<Set<string>>(new Set());
  const [runningSessions, setRunningSessions] = useState<string[]>([]);
  // DESK-5w — the viewed session key as REACTIVE state (sessionKeyRef is the
  // ref mirror). Drives session-scoped background-task views.
  const [viewKey, setViewKey] = useState<string>('');
  const setSessionRunning = (key: string, on: boolean): void => {
    const s = runningSessionsRef.current;
    if (on) s.add(key); else s.delete(key);
    setRunningSessions([...s]);
  };
  const [statusLine, setStatusLine] = useState('');
  const [reasoningTail, setReasoningTail] = useState('');
  const [liveText, setLiveText] = useState('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  // DESK-5n — in-turn child agents (workers/sub-agents) live ONLY in the
  // streamed child-* events, never in the disk-backed fleet the host polls,
  // so the Background-tasks panel was blind to them mid-turn. Track them live
  // here keyed by childId; upsert on child-tool-start/end, drop on complete.
  const [liveChildren, setLiveChildren] = useState<Record<string, { childId: string; role: string; tool?: string; startedAt: number }>>({});
  const [info, setInfo] = useState<{ sessionKey?: string; model?: string; workspaceRoot?: string; username?: string }>({});
  const [hostUp, setHostUp] = useState(false);
  const [interaction, setInteraction] = useState<InteractionRequest | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [workspaces, setWorkspaces] = useState<{ current: string | null; recents: string[] }>({ current: null, recents: [] });
  const [railOpen, setRailOpen] = useState(true);
  // DESK-5i — the left sidebar is drag-resizable too (persisted).
  const [railWidth, setRailWidth] = useState(() => {
    const v = Number(localStorage.getItem('br-rail-w'));
    return v >= 220 && v <= 420 ? v : 268;
  });

  // DESK-5f — ONE tabbed side panel (Codex model): views are tabs you switch
  // between, never extra window columns. Empty tab list = the view chooser.
  const [sideTabs, setSideTabs] = useState<PanelId[]>(() => devPanels());
  const [activeSideTab, setActiveSideTab] = useState<PanelId | null>(() => devPanels()[0] ?? null);
  const [sidePanelOpen, setSidePanelOpen] = useState(() => devFlag('side') || devPanels().length > 0);
  const [sideWidth, setSideWidth] = useState(330);
  // DESK-5h — measured room: the Environment COLUMN (it reserves layout space,
  // never overlays the chat) and its toggle yield when the chat would squeeze.
  const workrowRef = useRef<HTMLDivElement>(null);
  const [workW, setWorkW] = useState(0);
  const [termLines, setTermLines] = useState<string[]>([]);
  const [toolLog, setToolLog] = useState<Array<{ id: number; tool: string; ok: boolean; summary: string }>>([]);
  const [changedFiles, setChangedFiles] = useState<Array<{ status: string; path: string }>>([]);
  const [diffView, setDiffView] = useState<{ path: string; diff: string } | null>(null);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [fileView, setFileView] = useState<{ path: string; content: string; error?: string } | null>(null);
  const [gitInfo, setGitInfo] = useState<{ repo: string; branch: string | null; insertions: number; deletions: number } | null>(null);
  const [commitSubjects, setCommitSubjects] = useState<string[]>([]);
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
  // DESK-6m — per-chat ⋮ context menu + its sub-flows.
  const [sessionMenu, setSessionMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [sessionGroups, setSessionGroups] = useState<string[]>([]);
  const [homeStats, setHomeStats] = useState<{
    sessions: number; turns: number; activeDays: number; currentStreak: number;
    longestStreak: number; model: string; perDay: Record<string, number>;
  } | null>(null);
  const [statsTab, setStatsTab] = useState<'overview' | 'models'>('overview');
  const [statsRange, setStatsRange] = useState<'all' | '30d' | '7d'>('all');
  // DESK-4m — popovers (one open at a time) across composer, top bar, and menus.
  const [pop, setPop] = useState<'' | 'mode' | 'model' | 'effort' | 'ctx' | 'export' | 'branch' | 'plus' | 'splus' | 'bplus' | 'repo' | 'local' | 'commit' | 'title' | 'editor'>('');
  // DESK-5q/5r — context fill for the composer ring (vs the auto-compact limit).
  const [contextUsage, setContextUsage] = useState<{ used: number; window: number; compactAt: number; limit: number; pct: number } | null>(null);
  // DESK-5e — the Environment card is PINNED, not a transient popover: it
  // stays until the toggle is clicked again (Codex behavior) and survives
  // relaunches via localStorage.
  const [envOpen, setEnvOpen] = useState(() => localStorage.getItem('br-env-open') === '1');

  const liveBuf = useRef('');
  // DESK-5w (#4 lag) — coalesce streaming deltas: setLiveText at most ~16×/s
  // instead of on every ~18ms chunk, so the in-progress markdown re-parses far
  // less often. The final text always comes from liveBuf (flushAssistant), so
  // throttling never drops content.
  const liveFlushPending = useRef(false);
  const sessionsRef = useRef<SessionRow[]>([]);
  const lastPromptRef = useRef('');
  // DESK-5u — current viewed session key, kept in a ref so the (mount-once)
  // event handler can read it without going stale.
  const sessionKeyRef = useRef<string | undefined>(undefined);
  // DESK-5u — error cards aren't part of the persisted transcript, so cache
  // them per session here and re-inject on resume — a turn failure stays
  // visible when you switch away and come back.
  const errorsBySession = useRef<Record<string, Array<{ id: number; text: string; detail?: string; ts: number }>>>({});
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // DESK-6w — true while a read-only card view (task convo / workflow) is open,
  // so the transcript auto-scroll never yanks the card down on a refresh.
  const cardOpenRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [turnStart, setTurnStart] = useState(0);
  // DESK-5e — the Environment "Checks" row is real signal: failed tool calls
  // in the last completed turn (null until a turn has finished here).
  const [lastTurnFails, setLastTurnFails] = useState<number | null>(null);
  const turnFailsRef = useRef(0);
  // DESK-5j — Changes tab review actions (commit/push/pull via the host's
  // user-command shell path — same trust level as the terminal input row).
  const [gitBusy, setGitBusy] = useState(false);
  const [finishedTasks, setFinishedTasks] = useState<Array<{ id: string; label: string; status: string }>>([]);
  // DESK-5w — the background task whose conversation is open (read-only),
  // shown in place of the chat. null = normal chat view.
  const [taskView, setTaskView] = useState<{ id: string; kind: string; role?: string; goal?: string; status?: string; parentSessionKey?: string | null; rows: ChatRow[] } | null>(null);
  // DESK-6w — a workflow run's breakdown (Claude /workflows-style card), shown
  // in place of the chat when you click a workflow background task.
  const [workflowView, setWorkflowView] = useState<WorkflowDetail | null>(null);
  const [grepHits, setGrepHits] = useState<import('./panels.js').GrepHit[] | null>(null);
  const [inlineDiffs, setInlineDiffs] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<{ current: string | null; branches: string[] }>({ current: null, branches: [] });
  const [endpointModels, setEndpointModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [chatWidth, setChatWidth] = useState(() => localStorage.getItem('br-chat-w') ?? 'medium');
  const [chatSize, setChatSize] = useState(() => localStorage.getItem('br-chat-fs') ?? 'medium');
  // DESK-5d — the trust gate runs BEFORE a project opens (and before a chat
  // in another project resumes); `resume` carries the chat to land on.
  const [trustAsk, setTrustAsk] = useState<{ root: string; resume?: string } | null>(null);
  const [accent, setAccent] = useState(() => localStorage.getItem('br-accent') ?? '');
  // DESK-5d — per-project chat histories + expansion (lazy-fetched), the
  // current branch's PR chip, and the chat to resume after a host swap.
  const [projSessions, setProjSessions] = useState<Record<string, SessionRow[]>>({});
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const expandedProjectsRef = useRef<string[]>([]);
  const [prInfo, setPrInfo] = useState<{ number: number; state: string; title?: string } | null>(null);
  const pendingResumeRef = useRef<string | null>(null);
  // DESK-6t — debounce rapid session clicks: only the LAST target resumes.
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable handle so the mount-once keyboard handler always calls the latest one.
  const resumeSessionRef = useRef<(key: string) => void>(() => {});
  // DESK-4l/5f — bottom dock: tabbed like the side panel. Default tab is a
  // terminal; "+" adds more shells or any view as a tab. Shell sessions stay
  // mounted per tab.
  const [termDockOpen, setTermDockOpen] = useState(() => devFlag('terminal'));
  const [termDockHeight, setTermDockHeight] = useState(210);
  const [termTabs, setTermTabs] = useState<Array<{ id: number; kind: 'shell' | PanelId }>>([{ id: 1, kind: 'shell' }]);
  const [activeTerm, setActiveTerm] = useState(1);
  const termSeq = useRef(1);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const commands = useMemo(() => buildCommandList(catalog), [catalog]);

  const q = (id: string, name: string, args?: Record<string, unknown>) =>
    window.brainrouter.send({ kind: 'query', id, name, args });

  /** Open the bottom dock, re-seeding the default Terminal tab if all were closed. */
  function openBottomDock(): void {
    setTermTabs((tabs) => {
      if (tabs.length) return tabs;
      const id = ++termSeq.current;
      setActiveTerm(id);
      return [{ id, kind: 'shell' }];
    });
    setTermDockOpen(true);
  }
  /** Add (or focus) a bottom-dock tab; 'shell' always adds a fresh terminal. */
  function addBottomTab(kind: 'shell' | PanelId): void {
    setTermTabs((tabs) => {
      if (kind !== 'shell') {
        const existing = tabs.find((t) => t.kind === kind);
        if (existing) { setActiveTerm(existing.id); return tabs; }
      }
      const id = ++termSeq.current;
      setActiveTerm(id);
      return [...tabs, { id, kind }];
    });
    setTermDockOpen(true);
  }
  function closeBottomTab(id: number): void {
    setTermTabs((tabs) => {
      const next = tabs.filter((t) => t.id !== id);
      if (id === activeTerm && next.length) setActiveTerm(next[next.length - 1].id);
      if (next.length === 0) setTermDockOpen(false);
      return next;
    });
  }
  /** Show a view as the side panel's active tab (terminal lives in the dock). */
  function ensurePanel(id: PanelId): void {
    if (id === 'terminal') { openBottomDock(); return; }
    setSideTabs((t) => (t.includes(id) ? t : [...t, id]));
    setActiveSideTab(id);
    setSidePanelOpen(true);
  }
  function closeSideTab(id: PanelId): void {
    setSideTabs((tabs) => {
      const next = tabs.filter((t) => t !== id);
      if (activeSideTab === id) setActiveSideTab(next[next.length - 1] ?? null);
      return next;
    });
  }
  function togglePanel(id: PanelId): void {
    if (id === 'terminal') { setTermDockOpen((o) => !o); return; }
    if (sidePanelOpen && activeSideTab === id) { closeSideTab(id); return; }
    ensurePanel(id);
  }
  function openSideView(id: PanelId): void {
    if (id === 'terminal') { openBottomDock(); return; }
    ensurePanel(id);
  }
  function resizeTerminal(startHeight: number, startY: number, ev: React.PointerEvent): void {
    ev.preventDefault();
    const move = (e: PointerEvent) => {
      setTermDockHeight(Math.max(140, Math.min(Math.floor(window.innerHeight * 0.72), startHeight + startY - e.clientY)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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

  // ---- DESK-5d — single-window project switching --------------------------
  /** Swap the host to another workspace in THIS window; optionally land on a chat. */
  function switchToWorkspace(root: string, resumeKey?: string): void {
    const current = workspaces.current ?? info.workspaceRoot;
    if (root === current) {
      if (resumeKey) window.brainrouter.send({ kind: 'resume-session', sessionKey: resumeKey });
      return;
    }
    pendingResumeRef.current = resumeKey ?? null;
    setToast(`Opening ${root.split('/').pop()}…`);
    // Clear workspace-scoped surfaces; the new host's boot session-changed
    // refreshes everything against the new root.
    setHostUp(false);
    setRows([]);
    setGitInfo(null);
    setPrInfo(null);
    setBranches({ current: null, branches: [] });
    setChangedFiles([]);
    setAllFiles([]);
    setFileView(null);
    setDiffView(null);
    setTokens(null);
    setLastPlan(null);
    setFleet([]);
    setLiveChildren({});
    setCommitSubjects([]);
    // Terminal tabs belong to the retiring host's shells — close the dock so
    // reopening spawns fresh shells in the new workspace.
    setTermDockOpen(false);
    setTermTabs([{ id: ++termSeq.current, kind: 'shell' }]);
    setActiveTerm(termSeq.current);
    void window.brainrouter.openWorkspace(root).then((r) => {
      if (!r.opened) { setToast('✗ Could not open that folder.'); pendingResumeRef.current = null; }
    }).catch(() => { setToast('✗ Could not open that folder.'); pendingResumeRef.current = null; });
  }

  /** Trust gate in front of every project switch (Codex-style: ask first).
   *  T1 — trust now comes from the shared CLI store via main, not localStorage. */
  function openProject(root: string, resumeKey?: string): void {
    void window.brainrouter.isWorkspaceTrusted(root).then(({ trusted }) => {
      if (trusted) switchToWorkspace(root, resumeKey);
      else setTrustAsk({ root, resume: resumeKey });
    });
  }

  /** DESK-5j — Changes-tab review actions; results toast + refresh git state. */
  function runGit(kind: 'commit' | 'push' | 'pull', msg?: string): void {
    const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const cmd = kind === 'commit'
      ? `git add -A && git commit -m ${sq(msg ?? '')}`
      : kind === 'push' ? 'git push' : 'git pull --ff-only';
    setGitBusy(true);
    setToast(kind === 'commit' ? 'Committing…' : kind === 'push' ? 'Pushing…' : 'Pulling…');
    q('a-git', 'action:term-exec', { cmd });
  }

  /** Add project = pick folder → trust dialog right away → open in place.
   *  T1 — optimistically insert the folder into the sidebar's project list the
   *  moment it's picked, so it appears instantly (the real recents reconcile on
   *  open). De-duped against the existing recents. */
  function addProject(): void {
    void window.brainrouter.addWorkspace().then((res) => {
      if (!res?.workspaceRoot) return;
      const root = res.workspaceRoot;
      setWorkspaces((prev) => prev.recents.includes(root) ? prev : { ...prev, recents: [root, ...prev.recents] });
      openProject(root);
    }).catch(() => {});
  }

  /** Expand/collapse a project folder; first expand lazy-loads its chats. */
  function toggleProject(root: string): void {
    setExpandedProjects((prev) => {
      const next = prev.includes(root) ? prev.filter((r) => r !== root) : [...prev, root];
      expandedProjectsRef.current = next;
      return next;
    });
    if (!projSessions[root]) q(`q-wsess:${root}`, 'workspace-sessions', { root });
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
    // DESK-5r — context ring: lastSeenPromptTokens grows after each LLM call
    // within the turn, so polling shows context fill rise live. (The elapsed
    // timer is now self-contained in <WorkElapsed/>, so no app-wide tick here.)
    const fp = setInterval(() => { q('q-ctx', 'context-usage'); }, 2000);
    q('q-ctx', 'context-usage'); // immediate, don't wait the first interval
    return () => { clearInterval(fp); };
  }, [running]);

  // DESK-5w — keep the per-session background-task list fresh even when the
  // VIEWED chat is idle: another chat may be running work whose tasks should
  // appear/clear in the sidebar (and reflect the boot-time stale reconcile).
  useEffect(() => {
    const t = setInterval(() => q('q-fleet', 'fleet'), 3000);
    q('q-fleet', 'fleet');
    return () => clearInterval(t);
  }, []);

  // DESK-5w — while a task's conversation is open, refresh it so a running
  // worker/subagent's chat updates as it works.
  useEffect(() => {
    if (!taskView) return;
    const { kind, id, parentSessionKey } = taskView;
    const t = setInterval(() => q('q-task-transcript', 'task-transcript', { kind, id, parentSessionKey: parentSessionKey ?? '' }), 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskView?.id, taskView?.kind]);

  // DESK-6w — while a workflow card is open, refresh its phases/agent stats live.
  useEffect(() => {
    if (!workflowView) return;
    const slug = workflowView.slug;
    const t = setInterval(() => q('q-workflow-detail', 'workflow-detail', { slug }), 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowView?.slug]);

  // DESK-6w — keep the auto-scroll suppressor in sync with any card view.
  useEffect(() => { cardOpenRef.current = !!(taskView || workflowView); }, [taskView, workflowView]);

  useEffect(() => {
    document.documentElement.style.setProperty('--chat-w', chatWidth === 'narrow' ? '720px' : chatWidth === 'wide' ? '980px' : '840px');
    document.documentElement.style.setProperty('--chat-fs', chatSize === 'small' ? '13.5px' : chatSize === 'large' ? '15.5px' : '14.5px');
    localStorage.setItem('br-chat-w', chatWidth);
    localStorage.setItem('br-chat-fs', chatSize);
  }, [chatWidth, chatSize]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    localStorage.setItem('br-env-open', envOpen ? '1' : '0');
  }, [envOpen]);

  useEffect(() => {
    localStorage.setItem('br-rail-w', String(railWidth));
  }, [railWidth]);

  // DESK-5h — track the workrow's real width (window size AND panel state both
  // change it); drives the Environment column's show/yield logic.
  useEffect(() => {
    const el = workrowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWorkW(el.clientWidth));
    ro.observe(el);
    setWorkW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((p) => !p); }
      // View shortcuts (parity with the reference app's Views menu)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); togglePanel('diff'); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); togglePanel('files'); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); togglePanel('plan'); }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); togglePanel('files'); }
      if (e.ctrlKey && e.key === '`') { e.preventDefault(); setTermDockOpen((o) => !o); }
      if (mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const sess = sessionsRef.current[idx];
        if (sess) { e.preventDefault(); resumeSessionRef.current(sess.sessionKey); }
      }
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
    // DESK-5m — mark macOS so the rail can reserve the traffic-light strip
    // (the frameless hiddenInset window puts the lights over the top-left).
    if (/Mac/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent)) document.documentElement.dataset.os = 'mac';
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

  // DESK-5j — no auto-close at a px breakpoint: ⌘+/- zoom shrinks the CSS
  // viewport, and the rail vanishing mid-zoom read as the UI breaking apart.
  // Panels are user-controlled; columns shrink in place instead.

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
      liveFlushPending.current = false;
      setLiveText('');
      if (text) push({ id: rid(), kind: 'assistant', text, ts: Date.now() });
    };
    const off = window.brainrouter.onEvent((msg: AgentEventMessage) => {
      setHostUp(true);
      const e: AgentEvent = msg.event;
      // DESK-5v — route by session: a turn you started can keep running after
      // you switch chats; its events stay tagged with ITS key. Drop the purely
      // visual ones when they're not for the chat on screen.
      const isForeground = msg.sessionKey === sessionKeyRef.current;
      if (!isForeground && FOREGROUND_ONLY_KINDS.has(e.kind)) return;
      switch (e.kind) {
        case 'status': setStatusLine(e.text); break;
        case 'reasoning-delta': setReasoningTail((t) => (t + e.text).slice(-200)); break;
        case 'assistant-turn-start': liveBuf.current = ''; liveFlushPending.current = false; setLiveText(''); break;
        case 'assistant-delta':
          liveBuf.current += e.text;
          if (!liveFlushPending.current) {
            liveFlushPending.current = true;
            setTimeout(() => { liveFlushPending.current = false; setLiveText(liveBuf.current); }, 60);
          }
          break;
        case 'assistant-turn-end': flushAssistant(); break;
        case 'tool-end': {
          if (!e.ok) turnFailsRef.current += 1;
          pushTool({ id: rid(), tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok, file: fileFromSummary(e.tool, e.summary) });
          setToolLog((t) => [...t.slice(-199), { id: rid(), tool: e.tool, ok: e.ok, summary: e.summary }]);
          if ((e.tool === 'run_command' || e.tool === 'task_output') && (e.preview || e.summary)) {
            const text = (e.preview ?? e.summary).split('\n').slice(0, 40);
            setTermLines((l) => [...l.slice(-400), `$ ${e.tool}${e.ok ? '' : ' ✗'}`, ...text]);
          }
          break;
        }
        case 'child-tool-start':
          // DESK-5n — first sign of a live child: register it as running.
          setLiveChildren((m) => ({ ...m, [e.childId]: { childId: e.childId, role: e.role, tool: e.tool, startedAt: m[e.childId]?.startedAt ?? Date.now() } }));
          break;
        case 'child-tool-end':
          pushTool({ id: rid(), tool: e.tool, summary: e.summary, preview: e.preview, ok: e.ok, child: `${e.role}·${e.childId.slice(-4)}` });
          // Keep the live entry fresh (covers children whose first seen event is an end).
          setLiveChildren((m) => ({ ...m, [e.childId]: { childId: e.childId, role: e.role, tool: e.tool, startedAt: m[e.childId]?.startedAt ?? Date.now() } }));
          break;
        case 'child-complete':
          push({ id: rid(), kind: 'status', text: `${e.status === 'completed' ? '✓' : '✗'} agent ${e.childId} (${e.role}) ${e.status}`, ts: Date.now() });
          setFinishedTasks((f) => [...f.slice(-30), { id: `${e.childId}-${Date.now()}`, label: `${e.role}·${e.childId.slice(-4)}`, status: e.status === 'completed' ? 'Agent · Completed' : 'Agent · Failed' }]);
          setLiveChildren((m) => { const n = { ...m }; delete n[e.childId]; return n; });
          break;
        case 'plan-update':
          setLastPlan({ items: e.items, explanation: e.explanation });
          push({ id: rid(), kind: 'status', text: 'Updated the plan', ts: Date.now() });
          break;
        case 'compaction': push({ id: rid(), kind: 'status', text: `Compacted ${e.droppedMessages} → kept ${e.keptMessages}`, ts: Date.now() }); q('q-ctx', 'context-usage'); break;
        case 'memory': push({ id: rid(), kind: 'status', text: `${e.level === 'warn' ? '⚠ ' : ''}${e.text}`, ts: Date.now() }); break;
        case 'tokens-updated': setTokens({ promptTokens: e.promptTokens, completionTokens: e.completionTokens, turns: e.turns }); q('q-ctx', 'context-usage'); break;
        case 'interaction-request': setInteraction(e.request); setPicked([]); break;
        case 'session-changed':
          // DESK-5u — session-changed is the authoritative "current session"
          // signal; track it directly (info.sessionKey can be clobbered by a
          // q-info refresh, which would mis-bucket per-session errors).
          sessionKeyRef.current = e.sessionKey;
          setViewKey(e.sessionKey);
          setTaskView(null); setWorkflowView(null); // DESK-5w/6w — leaving closes any open task/workflow view
          // DESK-5v — the composer reflects whether the chat we just landed on
          // is itself running (it may be — a background turn you started here
          // earlier). Clear the transient per-turn surfaces either way.
          setRunning(runningSessionsRef.current.has(e.sessionKey));
          setStopping(false); // DESK-6 — a switch clears any pending stop indicator
          setStatusLine(''); setReasoningTail(''); setLiveText(''); liveBuf.current = '';
          if (e.loadedMessages > 0) {
            // Observed: a centered spinner while the transcript loads, then
            // the full history renders scrolled to the bottom.
            setRows([{ id: rid(), kind: 'loading', ts: Date.now() }]);
            setSearchHits(null);
            q('q-transcript', 'transcript', { sessionKey: e.sessionKey });
          } else if (e.loadedMessages === 0) {
            setRows([]);
            setSearchHits(null);
            setTimeout(() => { if (chatRef.current) chatRef.current.scrollTop = 0; }, 50);
          }
          setInfo((i) => ({ ...i, sessionKey: e.sessionKey, model: e.model || i.model }));
          // DESK-5d — a chat clicked under ANOTHER project: the new host has
          // just announced itself; now land on the chat that was clicked.
          {
            const want = pendingResumeRef.current;
            if (want) {
              pendingResumeRef.current = null;
              if (e.sessionKey !== want) window.brainrouter.send({ kind: 'resume-session', sessionKey: want });
            }
          }
          // DESK-6t — light refresh only: switching/creating a chat doesn't change
          // the workspace's git state, so don't fire the slow git/gh queries here.
          refreshSession();
          break;
        // DESK-5v — turn lifecycle is tracked PER SESSION so a background turn
        // keeps its spinner and lands its result/error in the right chat.
        case 'turn-start': setSessionRunning(msg.sessionKey, true); if (isForeground) setRunning(true); break;
        case 'turn-complete': {
          setSessionRunning(msg.sessionKey, false);
          if (!isForeground) { refreshSidebar(); break; } // background turn: its answer is on disk, re-read on switch-back
          flushAssistant();
          setRows((r) => (r.some((x) => x.kind === 'assistant') ? r : [...r, { id: rid(), kind: 'assistant', text: e.answer, ts: Date.now() }]));
          setRunning(false); setStopping(false); setStatusLine(''); setReasoningTail('');
          setLastTurnFails(turnFailsRef.current);
          setLiveChildren({}); // turn ended — refreshSidebar reseeds any detached workers
          refreshSidebar();
          break;
        }
        case 'turn-error': {
          setSessionRunning(msg.sessionKey, false);
          // DESK-5u/5v — record the error under the SESSION IT BELONGS TO (not
          // the one on screen) so it survives a switch-away-and-back, and a
          // background failure shows up when you return to that chat.
          const errId = rid();
          const errText = 'Something went wrong';
          const errSession = msg.sessionKey;
          const bucket = errorsBySession.current[errSession] ?? [];
          errorsBySession.current[errSession] = [...bucket.slice(-19), { id: errId, text: errText, detail: e.message, ts: Date.now() }];
          if (!isForeground) { refreshSidebar(); break; } // surfaces on switch-back via q-transcript re-injection
          flushAssistant();
          push({ id: errId, kind: 'error', text: errText, detail: e.message, ts: Date.now() });
          setRunning(false); setStopping(false); setStatusLine(''); setReasoningTail('');
          setLiveChildren({});
          // Observed: the app preserves your message on failure.
          setDraft((d) => d || lastPromptRef.current);
          break;
        }
        case 'query-result': handleQueryResult(e.id, e.ok ? e.result : undefined, e.ok ? undefined : (e as { error?: string }).error); break;
        default: break;
      }
      // Sticky-bottom: never yank the view while the user is reading scrollback.
      queueMicrotask(() => { if (atBottomRef.current && !cardOpenRef.current) chatEnd.current?.scrollIntoView({ behavior: 'auto' }); });
    });
    refreshSidebar();
    q('q-catalog', 'commands-catalog');
    q('q-snapshot', 'config-snapshot');
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleQueryResult(id: string, result: unknown, error?: string): void {
    if (error) { setToast(`✗ ${error}`); return; }
    // DESK-5d — per-project chat lists route by the root encoded in the id.
    if (id.startsWith('q-wsess:')) {
      const root = id.slice('q-wsess:'.length);
      if (Array.isArray(result)) setProjSessions((p) => ({ ...p, [root]: result as SessionRow[] }));
      return;
    }
    switch (id) {
      case 'q-sessions': if (Array.isArray(result)) { setSessions(result as SessionRow[]); sessionsRef.current = result as SessionRow[]; } return;
      case 'q-pr': setPrInfo(((result as { pr?: { number: number; state: string; title?: string } | null })?.pr) ?? null); return;
      case 'q-ctx': if (result && typeof result === 'object') setContextUsage(result as { used: number; window: number; compactAt: number; limit: number; pct: number }); return;
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
      case 'q-gitlog': if (result && typeof result === 'object') setCommitSubjects(((result as { subjects?: string[] }).subjects ?? [])); return;
      case 'q-home': if (result && typeof result === 'object') setHomeStats(result as typeof homeStats); return;
      case 'q-branches': if (result && typeof result === 'object') setBranches(result as typeof branches); return;
      case 'q-models': {
        setModelsLoading(false);
        if (result && typeof result === 'object') setEndpointModels(((result as { models?: string[] }).models ?? []));
        return;
      }
      case 'q-catalog': if (result && typeof result === 'object') setCatalog(result as CommandsCatalog); return;
      case 'q-snapshot': if (result && typeof result === 'object') setSnapshot(result as ConfigSnapshot); return;
      case 'q-usage': if (Array.isArray(result)) setUsageLines(result as string[]); return;
      case 'q-search': if (Array.isArray(result)) setSearchHits(result as SearchHit[]); return;
      case 'q-grep': if (Array.isArray(result)) setGrepHits(result as import('./panels.js').GrepHit[]); return;
      case 'q-transcript': {
        const data = result as { sessionKey?: string; rows?: Array<{ kind: string; text?: string; tools?: number; ts?: number; items?: Array<{ tool: string; summary: string; preview?: string; ok: boolean; file?: string }> }> };
        const mapped: ChatRow[] = (data?.rows ?? []).map((r) => {
          // DESK-6t — use the persisted per-message timestamp so resumed history
          // shows the REAL relative time, not "just now".
          const ts = r.ts ?? Date.now();
          if (r.kind === 'user') return { id: rid(), kind: 'user' as const, text: r.text ?? '', ts };
          if (r.kind === 'assistant') return { id: rid(), kind: 'assistant' as const, text: r.text ?? '', ts };
          // DESK-5p — reconstructed tool calls render as the live tool-group card.
          if (r.kind === 'tool-group') return {
            id: rid(), kind: 'tool-group' as const, ts,
            items: (r.items ?? []).map((it) => ({ id: rid(), tool: it.tool, summary: it.summary, preview: it.preview, ok: it.ok, file: it.file })),
          };
          return { id: rid(), kind: 'status' as const, text: `Used ${r.tools ?? 0} tool${(r.tools ?? 0) === 1 ? '' : 's'}`, ts };
        });
        // DESK-5u — re-inject any cached errors for this session so a failure
        // you saw earlier is still there after switching away and back.
        const cachedErrors = errorsBySession.current[data?.sessionKey ?? ''] ?? [];
        setRows([
          { id: rid(), kind: 'status', text: `Resumed ${data?.sessionKey ?? 'session'} — ${mapped.length} entries.`, ts: Date.now() },
          ...mapped,
          ...cachedErrors.map((er) => ({ id: er.id, kind: 'error' as const, text: er.text, detail: er.detail, ts: er.ts })),
        ]);
        atBottomRef.current = true;
        setAtBottom(true);
        setTimeout(() => chatEnd.current?.scrollIntoView({ behavior: 'auto' }), 50);
        return;
      }
      // DESK-5w — a background task's conversation, opened read-only over the chat.
      case 'q-task-transcript': {
        const data = result as { id: string; kind: string; role?: string; goal?: string; status?: string; rows?: Array<{ kind: string; text?: string; ts?: number; items?: Array<{ tool: string; summary: string; preview?: string; ok: boolean; file?: string }> }> };
        const mapped: ChatRow[] = (data?.rows ?? []).map((r, i) => {
          const ts = r.ts ?? Date.now();
          // DESK-6v — STABLE, index-based keys: the 2.5s live poll re-sends the
          // same rows, and random ids made React remount EVERY row each time
          // (the flashing). Stable keys let it reconcile in place instead.
          if (r.kind === 'user') return { id: i, kind: 'user' as const, text: r.text ?? '', ts };
          if (r.kind === 'assistant') return { id: i, kind: 'assistant' as const, text: r.text ?? '', ts };
          if (r.kind === 'tool-group') return { id: i, kind: 'tool-group' as const, ts, items: (r.items ?? []).map((it, j) => ({ id: j, tool: it.tool, summary: it.summary, preview: it.preview, ok: it.ok, file: it.file })) };
          return { id: i, kind: 'status' as const, text: r.text ?? '', ts };
        });
        // DESK-6v — and skip the state update entirely when nothing changed, so a
        // stable transcript doesn't re-render (and flash) every poll.
        const sig = (rows: ChatRow[], status?: string): string => `${status ?? ''}|` + rows.map((r) => r.kind === 'tool-group'
          ? `tg:${(r.items ?? []).map((it) => it.tool + it.summary + (it.ok ? '1' : '0')).join(',')}`
          : `${r.kind}:${(r as { text?: string }).text ?? ''}`).join('§');
        setTaskView((prev) => {
          if (prev && sig(prev.rows, prev.status) === sig(mapped, data.status)) return prev;
          return { id: data.id, kind: data.kind, role: data.role, goal: data.goal, status: data.status, parentSessionKey: prev?.parentSessionKey, rows: mapped };
        });
        return;
      }
      // DESK-6w — workflow run breakdown for the /workflows-style card.
      case 'q-workflow-detail': {
        if (result && typeof result === 'object') setWorkflowView(result as WorkflowDetail);
        else setWorkflowView((prev) => prev ? { ...prev, status: 'gone' } : prev);
        return;
      }
      // DESK-6m — per-chat ⋮ menu action results: refresh the sidebar list.
      case 'q-session-meta': {
        if (result && typeof result === 'object' && Array.isArray((result as { groups?: unknown }).groups)) setSessionGroups((result as { groups: string[] }).groups);
        refreshSession();
        return;
      }
      case 'q-session-delete': refreshSession(); return;
      case 'q-session-fork': {
        const nk = (result as { newKey?: string } | undefined)?.newKey;
        refreshSession();
        if (nk) window.brainrouter.send({ kind: 'resume-session', sessionKey: nk });
        return;
      }
      case 'q-session-groups': if (result && typeof result === 'object' && Array.isArray((result as { groups?: unknown }).groups)) setSessionGroups((result as { groups: string[] }).groups); return;
      case 'q-open-external': return; // fire-and-forget
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
      case 'a-git': {
        const r = result as { out?: string; code?: number };
        setGitBusy(false);
        const first = (r?.out ?? '').split('\n').find((l) => l.trim()) ?? '';
        setToast(r?.code ? `✗ ${first || `git exited ${r.code}`}` : `✓ ${first || 'Done'}`);
        q('q-git', 'git-info');
        q('q-files', 'changed-files');
        q('q-branches', 'git-branches');
        q('q-gitlog', 'git-log');
        q('q-pr', 'git-pr');
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
      case 'a-clear': setRows([]); if (sessionKeyRef.current) delete errorsBySession.current[sessionKeyRef.current]; setToast('History cleared.'); return;
      case 'a-compact': setInfoDialog({ title: 'Compaction', body: result ? fmt(result) : 'Nothing to compact yet.' }); return;
      case 'a-pref': q('q-snapshot', 'config-snapshot'); setToast('Saved — shared with the CLI.'); return;
      case 'a-hook': q('q-snapshot', 'config-snapshot'); setToast('Hook updated.'); return;
      case 'a-access': setToast('Access mode set for this session.'); return;
      case 'a-reconnect': q('q-snapshot', 'config-snapshot'); setToast('Reconnect requested.'); return;
      default: return;
    }
  }

  // DESK-6t — FAST, session-scoped refresh: the sidebar chat list, active-session
  // info, running tasks, and the context ring — NO git/gh calls. Fired on every
  // session switch / New chat so creating or switching a chat stays snappy and
  // never blocks the host's message loop on `git ls-files` / `gh pr view`.
  function refreshSession(): void {
    q('q-sessions', 'list-sessions');
    q('q-info', 'session-info');
    q('q-fleet', 'fleet');
    q('q-ctx', 'context-usage');
  }
  // Full refresh INCL. the slow git/workspace queries — only needed on boot, a
  // workspace switch, and after a turn (files may have changed), NOT on every
  // session switch (the git state is identical across chats in one workspace).
  function refreshSidebar(): void {
    void window.brainrouter.workspaceRecents().then(setWorkspaces).catch(() => {});
    refreshSession();
    q('q-files', 'changed-files');
    q('q-list', 'list-files');
    q('q-git', 'git-info');
    q('q-home', 'home-stats');
    q('q-branches', 'git-branches');
    q('q-pr', 'git-pr');
    q('q-gitlog', 'git-log'); // pinned Environment card shows the last commit
    // Keep expanded project folders fresh (host caches make this cheap).
    for (const root of expandedProjectsRef.current) q(`q-wsess:${root}`, 'workspace-sessions', { root });
  }

  function answerInteraction(response: { type: 'confirm'; approved: boolean } | { type: 'choice'; labels: string[] } | { type: 'dismissed' }): void {
    if (!interaction) return;
    window.brainrouter.send({ kind: 'interaction-response', id: interaction.id, response });
    setInteraction(null);
  }

  // DESK-6 — press Stop: fire the interrupt AND give instant feedback. The host
  // now aborts the in-flight LLM call / tool / children, so the turn unwinds in
  // well under a second; this just makes the UI say so immediately instead of
  // looking frozen behind a status line the next event overwrites.
  function requestStop(): void {
    if (!running || stopping) return;
    window.brainrouter.send({ kind: 'interrupt' });
    setStopping(true);
    setStatusLine('Stopping…');
    setRows((r) => [...r, { id: rid(), kind: 'status', text: '⏹ Stopping…', ts: Date.now() }]);
  }

  function submit(): void {
    const prompt = draft.trim();
    if (!prompt || running || stopping) return;
    // T8 — a slash command is NEVER sent to the LLM. Route it through the
    // command registry: bridge runs against the CLI stores, known commands run
    // their wire (panel/settings/native/cli fallback), and an UNKNOWN slash
    // surfaces a command-output card instead of becoming a chat prompt.
    const slash = resolveSlashInput(prompt, commands);
    if (slash.kind !== 'not-slash') {
      setDraft('');
      if (slash.kind === 'bridge') runBridge(slash.cmd, slash.args);
      else if (slash.kind === 'command') runCommand(slash.command, cmdCtx);
      else setRows((r) => [...r, { id: rid(), kind: 'cmd-out', cmd: prompt,
        lines: [`Unknown command \`${slash.base}\` — type \`/\` to browse commands, or run it in the terminal CLI.`], ts: Date.now() }]);
      return;
    }
    lastPromptRef.current = prompt;
    setRows((r) => [...r, { id: rid(), kind: 'user', text: prompt, ts: Date.now() }]);
    setDraft('');
    setRunning(true);
    // DESK-5v — mark THIS session running so its spinner survives a switch away.
    setSessionRunning(sessionKeyRef.current ?? info.sessionKey ?? '', true);
    setTurnStart(Date.now());
    turnFailsRef.current = 0;
    // DESK-6t — show this chat in "Projects" IMMEDIATELY (optimistic row), so a
    // brand-new chat doesn't stay invisible in the sidebar until the turn ends.
    // refreshSession() shortly after reconciles it with the host-backed row.
    const sk = sessionKeyRef.current ?? info.sessionKey;
    if (sk) {
      setSessions((prev) => prev.some((s) => s.sessionKey === sk)
        ? prev
        : [{ sessionKey: sk, firstUserMessage: prompt, modifiedAt: new Date().toISOString(), turnCount: 1, lastRole: 'user' }, ...prev]);
      setTimeout(() => refreshSession(), 400);
    }
    window.brainrouter.send({ kind: 'start-turn', prompt });
  }

  // DESK-5n — the Running list the panels show: live in-turn children (from
  // child-* events) unioned with the disk-backed fleet (detached /bg workers,
  // workflows). Dedup by id, preferring the disk entry (it carries worktree).
  const runningTasks = useMemo<FleetRow[]>(() => {
    const byId = new Map<string, FleetRow>();
    for (const c of Object.values(liveChildren)) {
      byId.set(c.childId, { kind: 'agent', id: c.childId, label: `${c.role}·${c.childId.slice(-4)}${c.tool ? ` — ${c.tool}` : ''}`, role: c.role, startedAt: new Date(c.startedAt).toISOString(), parentSessionKey: viewKey });
    }
    for (const f of fleet) byId.set(f.id, f); // disk entry wins on collision
    return [...byId.values()];
  }, [liveChildren, fleet, viewKey]);
  // DESK-5w — disk-backed tasks grouped by the chat that owns them, for nesting
  // each task UNDER its session in the sidebar (#2).
  const tasksBySession = useMemo(() => {
    const m = new Map<string, FleetRow[]>();
    for (const f of fleet) {
      const k = f.parentSessionKey ?? '';
      const arr = m.get(k); if (arr) arr.push(f); else m.set(k, [f]);
    }
    return m;
  }, [fleet]);
  // DESK-5w — only the VIEWED chat's tasks, for the Background-tasks panel + env
  // card (#5: switching main session must not show another session's tasks).
  const activeSessionTasks = useMemo<FleetRow[]>(
    () => runningTasks.filter((t) => (t.parentSessionKey ?? '') === (viewKey ?? '')),
    [runningTasks, viewKey],
  );
  // Tasks to nest under a given session row: the viewed session shows live +
  // disk; others show their disk-backed tasks.
  // DESK-6w (#5) — ONLY the active/viewed chat expands its background tasks in
  // the sidebar; switching chats must not surface other sessions' tasks. Inactive
  // sessions get a count chip instead (see the session row), so the info isn't lost.
  const tasksForSession = (key: string): FleetRow[] => (key === viewKey ? activeSessionTasks : []);
  const bgTaskCount = (key: string): number => (key === viewKey ? activeSessionTasks.length : (tasksBySession.get(key)?.length ?? 0));
  // DESK-6u — if the chat on screen was forked, resolve its parent so we can show
  // a "Forked from conversation" link back to the original.
  const forkParent = useMemo(() => {
    const fk = sessions.find((s) => s.sessionKey === viewKey)?.forkedFrom;
    return fk ? { key: fk, title: sessions.find((s) => s.sessionKey === fk)?.firstUserMessage } : null;
  }, [sessions, viewKey]);
  // DESK-5w/6w — open a background task. A workflow opens the /workflows-style
  // card (phases + agents); an agent/worker opens its conversation. Read-only
  // views open at the TOP and don't auto-follow new content.
  const viewToTop = (): void => { atBottomRef.current = false; setTimeout(() => { if (chatRef.current) chatRef.current.scrollTop = 0; }, 50); };

  // DESK-6t — switch chats responsively: a no-op when you're already there;
  // otherwise show the loading state INSTANTLY (so the click never feels stuck)
  // and debounce the actual resume so spam-clicking only loads the final target.
  const resumeSession = (key: string): void => {
    if (!key || key === sessionKeyRef.current) return;
    setTaskView(null); setWorkflowView(null);
    sessionKeyRef.current = key; setViewKey(key);
    setRows([{ id: rid(), kind: 'loading', ts: Date.now() }]);
    setSearchHits(null); setStatusLine(''); setReasoningTail(''); setLiveText(''); liveBuf.current = '';
    setRunning(runningSessionsRef.current.has(key));
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => { window.brainrouter.send({ kind: 'resume-session', sessionKey: key }); }, 120);
  };
  resumeSessionRef.current = resumeSession;

  const openTask = (f: FleetRow): void => {
    if (f.kind === 'workflow') { openWorkflow(f.id); return; }
    setTaskView({ id: f.id, kind: f.kind, role: f.role, status: 'running', parentSessionKey: f.parentSessionKey, rows: [{ id: rid(), kind: 'loading', ts: Date.now() }] });
    q('q-task-transcript', 'task-transcript', { kind: f.kind, id: f.id, parentSessionKey: f.parentSessionKey ?? '' });
    viewToTop();
  };
  const openWorkflow = (slug: string): void => {
    const now = new Date().toISOString();
    setWorkflowView({ slug, kind: '', status: 'running', startedAt: now, updatedAt: now, totalAgents: 0, totalTokens: 0, phases: [], steps: [] });
    q('q-workflow-detail', 'workflow-detail', { slug });
    viewToTop();
  };

  // DESK-6m — per-chat ⋮ menu actions. Each writes the shared CLI store via a
  // host action, then refreshes the sidebar list.
  const closeSessionMenu = (): void => setSessionMenu(null);
  const setMeta = (key: string, patch: Record<string, unknown>): void => { q('q-session-meta', 'action:session-meta', { sessionKey: key, patch }); closeSessionMenu(); };
  const togglePin = (s: SessionRow): void => setMeta(s.sessionKey, { pinned: !s.pinned });
  const toggleComplete = (s: SessionRow): void => setMeta(s.sessionKey, { status: s.status === 'completed' ? 'active' : 'completed' });
  const toggleArchive = (s: SessionRow): void => setMeta(s.sessionKey, { archived: !s.archived });
  const moveToGroup = (key: string, group: string | null): void => setMeta(key, { group });
  const startRename = (s: SessionRow): void => { setRenamingKey(s.sessionKey); setRenameDraft(s.firstUserMessage || ''); closeSessionMenu(); };
  const commitRename = (): void => { if (renamingKey) q('q-session-meta', 'action:session-meta', { sessionKey: renamingKey, patch: { title: renameDraft.trim() } }); setRenamingKey(null); };
  // DESK-6v — upToTs (a message's epoch-ms ts) branches the fork at that message;
  // omitted (the ⋮ menu) forks the whole conversation.
  const forkSessionAction = (key: string, upToTs?: number): void => { q('q-session-fork', 'action:session-fork', { sessionKey: key, ...(upToTs != null ? { upToTs } : {}) }); closeSessionMenu(); };
  const deleteSessionAction = (key: string): void => {
    closeSessionMenu();
    if (!window.confirm('Delete this chat permanently? This removes its transcript from disk.')) return;
    q('q-session-delete', 'action:session-delete', { sessionKey: key });
    if (sessionKeyRef.current === key) window.brainrouter.send({ kind: 'new-session' });
  };
  const openExternal = (what: string): void => { q('q-open-external', 'action:open-external', { what }); closeSessionMenu(); };
  const openSessionMenu = (e: React.MouseEvent, key: string): void => {
    e.preventDefault(); e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    q('q-session-groups', 'action:session-groups'); // refresh the Move-to-group list
    setSessionMenu({ key, x: Math.min(r.left, window.innerWidth - 250), y: r.bottom + 4 });
  };

  // DESK-6m — one chat row (with its ⋮ menu trigger + pinned/completed state +
  // inline rename) plus its nested background tasks. Reused for grouped sections.
  const renderSessionNode = (s: SessionRow, i: number): React.ReactElement => (
    <React.Fragment key={s.sessionKey}>
      <div className={`session-wrap${s.sessionKey === viewKey ? ' active' : ''}${s.status === 'completed' ? ' completed' : ''}${sessionMenu?.key === s.sessionKey ? ' menu-open' : ''}`}>
        {renamingKey === s.sessionKey ? (
          <input className="session-rename" autoFocus value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenamingKey(null); }}
            onBlur={commitRename} />
        ) : (
          <button className="project-session" title={s.sessionKey}
            onClick={() => resumeSession(s.sessionKey)}>
            {s.pinned ? <span className="st st-pin" title="Pinned"><Icon name="pin" size={11} /></span>
              : (s.forkedFrom && !runningSessions.includes(s.sessionKey))
                ? <span className="st st-fork" title="Forked conversation"><Icon name="branch" size={11} /></span>
                : <SessionStatus s={s} working={runningSessions.includes(s.sessionKey)} />}
            <span className="session-title">{s.firstUserMessage || s.sessionKey}</span>
            {s.status === 'completed' ? <span className="session-done" title="Completed"><Icon name="check-circle" size={11} /></span> : null}
            {!s.group && i < 9 ? <span className="session-cmd">⌘{i + 1}</span> : null}
            {s.sessionKey !== viewKey && bgTaskCount(s.sessionKey) > 0
              ? <span className="session-bg" title={`${bgTaskCount(s.sessionKey)} background task(s) — open this chat to view`}>{bgTaskCount(s.sessionKey)}</span> : null}
            {s.modifiedAt ? <span className="session-age">{fmtAge(s.modifiedAt)}</span> : null}
          </button>
        )}
        <button className="session-menu-btn icon-btn" title="Chat options" onClick={(e) => openSessionMenu(e, s.sessionKey)}><Icon name="dots" size={13} /></button>
      </div>
      {tasksForSession(s.sessionKey).map((f) => (
        <button key={f.id} className={`project-session task nested${taskView?.id === f.id ? ' active' : ''}`}
          title={`${f.kind} · ${f.id}${f.role ? ' · ' + f.role : ''} — click to view its conversation`}
          onClick={() => openTask(f)}>
          <span className={`st st-task ${f.kind}`}>{f.worktree ? <Icon name="merge" size={11} /> : <span className="task-dot" />}</span>
          <span className="session-title">{f.label}</span>
          <span className="st"><span className="spinner sm" /></span>
        </button>
      ))}
    </React.Fragment>
  );

  // DESK-5w (#4 lag) — render ONE transcript row. Extracted + memoized (below)
  // so streaming deltas / the per-second tick don't re-render the whole history
  // (every <Markdown> was re-parsing on every ~18ms delta — the source of lag).
  const renderRow = (r: ChatRow, liveLast: boolean): React.ReactElement | null => {
    switch (r.kind) {
      case 'user': return (
        <div key={r.id} className="row user-row">
          <div className="user">{r.text}</div>
          <span className="msg-actions">
            <button className="icon-btn" title="Copy" onClick={() => void navigator.clipboard.writeText(r.text)}><Icon name="copy" size={11} /></button>
            <span className="msg-time">{fmtRel(r.ts)}</span>
          </span>
        </div>
      );
      case 'assistant': return (
        <div key={r.id} className="row assistant md">
          <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{r.text}</Markdown>
          <span className="msg-actions">
            <button className="icon-btn" title="Copy" onClick={() => void navigator.clipboard.writeText(r.text)}><Icon name="copy" size={11} /></button>
            <button className="icon-btn" title="Fork into a new chat from this message" onClick={() => forkSessionAction(sessionKeyRef.current ?? '', r.ts)}><Icon name="fork" size={11} /></button>
            <span className="msg-time">{fmtRel(r.ts)}</span>
          </span>
        </div>
      );
      case 'tool-group': return <div key={r.id} className="row"><ToolGroup row={r} live={liveLast} inlineDiffs={inlineDiffs} onRequestDiff={(f) => q('q-inline-diff', 'file-diff', { path: f })} /></div>;
      case 'error': return (
        <div key={r.id} className="row">
          <div className="error-card">
            <button className="icon-btn err-x" onClick={() => {
              setRows((rs) => rs.filter((x) => x.id !== r.id));
              for (const k of Object.keys(errorsBySession.current)) errorsBySession.current[k] = errorsBySession.current[k].filter((er) => er.id !== r.id);
            }}>✕</button>
            <span className="error-icon"><Icon name="warn" size={15} /></span>
            <div className="error-title">{r.text}</div>
            <div className="error-advice">Try sending your message again — your draft was kept. If it keeps happening, check the host log.</div>
            {r.detail ? <div className="error-detail">{r.detail}</div> : null}
          </div>
        </div>
      );
      case 'loading': return <div key={r.id} className="row history-loading"><span className="spinner big" /></div>;
      case 'cmd-out': return (
        <div key={r.id} className="row">
          <div className="cmd-out">
            <div className="cmd-out-head">{r.cmd}</div>
            <pre>{r.lines.join('\n')}</pre>
          </div>
        </div>
      );
      case 'status': return <div key={r.id} className="row status">{r.text}</div>;
      default: return null;
    }
  };
  // Memoized on [rows, inlineDiffs, running] ONLY — NOT liveText/nowTick — so the
  // in-progress stream below re-renders alone, leaving history untouched.
  const transcriptEls = useMemo(
    () => rows.map((r, i) => renderRow(r, running && i === rows.length - 1)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, inlineDiffs, running],
  );

  const statuses = useMemo(() => new Map(changedFiles.map((f) => [f.path, f.status])), [changedFiles]);
  const sessionTitle = useMemo(() => {
    const firstUser = rows.find((r) => r.kind === 'user') as { text: string } | undefined;
    return firstUser ? firstUser.text.slice(0, 48) : 'New session';
  }, [rows]);


  const hasConversation = useMemo(() => rows.some((r) => r.kind === 'user' || r.kind === 'assistant' || r.kind === 'tool-group'), [rows]);
  // DESK-6w — a card view (task convo / workflow) takes over the chat area, so
  // the home-mode vertical centering must NOT apply (it would push the card up).
  const homeMode = !hasConversation && !liveText && !running && !taskView && !workflowView;

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
  // DESK-6m — hide archived (unless toggled), keep pinned first, optionally
  // alpha-sort, and split out grouped chats into their own sections.
  const liveSessions = useMemo(() => {
    let list = sessions.filter((s) => showArchived || !s.archived);
    if (recentsSort === 'alpha') list = [...list].sort((a, b) => (a.firstUserMessage ?? a.sessionKey).localeCompare(b.firstUserMessage ?? b.sessionKey));
    return [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)); // pinned first (stable)
  }, [sessions, showArchived, recentsSort]);
  const archivedCount = useMemo(() => sessions.filter((s) => s.archived).length, [sessions]);
  const ungroupedSessions = useMemo(() => liveSessions.filter((s) => !s.group), [liveSessions]);
  const groupedSessions = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const s of liveSessions) if (s.group) { const arr = m.get(s.group); if (arr) arr.push(s); else m.set(s.group, [s]); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [liveSessions]);
  const visibleProjectSessions = recentsOpen ? ungroupedSessions.slice(0, 7) : ungroupedSessions.slice(0, 3);
  const hiddenProjectSessions = Math.max(0, ungroupedSessions.length - visibleProjectSessions.length);
  const currentProjectName = workspaces.current?.split('/').pop() ?? info.workspaceRoot?.split('/').pop() ?? 'No workspace';
  const otherProjects = workspaces.recents.filter((w) => w !== workspaces.current && w !== info.workspaceRoot).slice(0, 6);

  function runSlash(c: DeskCommand): void {
    setDraft('');
    setSlashSel(0);
    runCommand(c, cmdCtx);
  }

  // DESK-5f — tab CONTENT only; the tab strip owns titles and closing.
  const renderPanelBody = (id: PanelId): React.ReactElement | null => {
    switch (id) {
      case 'context': return (
        <>
          <div className="kv"><span>Host</span><b><span className={`dot ${hostUp ? 'on' : 'off'}`} />{hostUp ? 'online' : 'starting…'}</b></div>
          <div className="kv"><span>Model</span><b>{info.model ?? '—'}</b></div>
          <div className="kv"><span>Workspace</span><b title={info.workspaceRoot}>{info.workspaceRoot?.split('/').pop() ?? '—'}</b></div>
          <div className="kv"><span>Tokens</span><b>{tokens ? `${tokens.promptTokens.toLocaleString()} in / ${tokens.completionTokens.toLocaleString()} out` : '—'}</b></div>
          <div className="kv"><span>Config</span><b>~/.config/brainrouter</b></div>
        </>);
      case 'files': return <FilesPanel files={allFiles} statuses={statuses} onOpen={openFile} grepHits={grepHits} onGrep={(gq) => q('q-grep', 'search-content', { q: gq })} />;
      case 'file': return <FileViewerPanel view={fileView} />;
      case 'diff': return (
        <DiffPanel gitInfo={gitInfo} changed={changedFiles} diff={diffView}
          onPick={(p) => q('q-diff', 'file-diff', { path: p })}
          onBack={() => setDiffView(null)} onOpenFile={openFile}
          onGit={runGit} gitBusy={gitBusy} />);
      case 'terminal': return <TerminalPanel />;
      case 'tools': return <ToolsPanel log={toolLog} />;
      case 'tasks': return <TasksPanel fleet={activeSessionTasks} finished={finishedTasks} onClear={() => setFinishedTasks([])} onOpen={(id) => { const f = activeSessionTasks.find((t) => t.id === id); if (f) openTask(f); }} />;
      case 'plan': return <PlanPanel plan={lastPlan} />;
      case 'search': return <SearchPanel hits={searchHits} onSearch={(query) => q('q-search', 'search-transcript', { q: query })} />;
      default: return null;
    }
  };
  const tabTitle = (id: PanelId): string =>
    id === 'file' && fileView?.path ? fileView.path.split('/').pop()! : PANEL_DEFS.find((d) => d.id === id)?.title ?? id;

  // DESK-5f/5h — animated presence for every show/hide surface.
  // Env column may ONLY appear when the chat keeps its full natural content
  // width (760px content + padding ≈ 820): opening Environment must never
  // visibly shrink the conversation. No room → column AND toggle yield.
  const envRoom = workW === 0 || workW - (sidePanelOpen ? sideWidth : 0) - 316 >= 820;
  const envVisible = envOpen && !homeMode && envRoom;
  const railAnim = useClosable(railOpen);
  const sideAnim = useClosable(sidePanelOpen);
  const dockAnim = useClosable(termDockOpen);
  const envAnim = useClosable(envVisible, 150);

  return (
    <div className="app">
      {railAnim.mounted ? (
        <nav className={`rail${railAnim.closing ? ' closing' : ''}`} style={{ width: railWidth }}>
          <div className="rail-grip" title="Drag to resize · drag far left to hide"
            onPointerDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startW = railWidth;
              const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
              // DESK-5k — Codex swipe-to-hide: dragging well past the minimum
              // collapses the sidebar (exit animation plays); width survives
              // for the next open.
              const move = (ev: PointerEvent) => {
                const w = startW + ev.clientX - startX;
                if (w < 165) { up(); setRailOpen(false); return; }
                setRailWidth(Math.max(220, Math.min(420, w)));
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }} />
          <div className="rail-top">
            <button className="icon-btn" title="Toggle sidebar" onClick={() => setRailOpen(false)}><Icon name="layout" size={15} /></button>
            <button className="icon-btn" title="Search commands (⌘K)" onClick={() => setPaletteOpen(true)}><Icon name="search" size={14} /></button>
          </div>
          <div className="rail-card">
            <div className="rail-actions">
              <button className="rail-action primary" onClick={() => window.brainrouter.send({ kind: 'new-session' })}><Icon name="plus" size={13} />New chat</button>
              <button className="rail-action" title="Search chats" onClick={() => ensurePanel('search')}><Icon name="search" size={13} /></button>
              <button className="rail-action" title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}><Icon name="command" size={13} /></button>
              <button className="rail-action" title="Workbench" onClick={() => setSidePanelOpen(true)}><Icon name="panels" size={13} /></button>
            </div>
            <div className="projects-head">
              <span>Projects</span>
              <button className="icon-btn" title={`Sort chats: ${recentsSort}`} onClick={() => setRecentsSort((s) => (s === 'recent' ? 'alpha' : 'recent'))}><Icon name="sort" size={12} /></button>
            </div>
            <div className="projects-scroll">
              <div className="project-block">
                <button className="project-row active" title={workspaces.current ?? info.workspaceRoot} onClick={() => setRecentsOpen((o) => !o)}>
                  <Icon name="folder-open" size={15} />
                  <span>{currentProjectName}</span>
                  <span className="project-meta">
                    {prInfo ? (
                      <span className={`pr-chip ${prInfo.state.toLowerCase()}`}
                        title={`#${prInfo.number} · ${prInfo.state.charAt(0)}${prInfo.state.slice(1).toLowerCase()}${prInfo.title ? ` — ${prInfo.title}` : ''}`}>
                        <Icon name="merge" size={12} />
                      </span>
                    ) : null}
                    <Icon name={recentsOpen ? 'chev-down' : 'chev-right'} size={10} className="project-chev" />
                  </span>
                </button>
                <div className="project-sessions">
                  {/* DESK-5w/6m — chats (with per-chat ⋮ menu) + their nested
                      background tasks; pinned first, grouped sections below. */}
                  {visibleProjectSessions.map((s, i) => renderSessionNode(s, i))}
                  {hiddenProjectSessions > 0 ? (
                    <button className="show-more" onClick={() => setRecentsOpen((o) => !o)}>
                      {recentsOpen ? 'Show fewer' : `Show ${hiddenProjectSessions} more`}
                    </button>
                  ) : null}
                  {/* DESK-6m — grouped chats as their own labeled sections. */}
                  {groupedSessions.map(([group, items]) => (
                    <div key={group} className="session-group">
                      <div className="session-group-head"><Icon name="folder" size={11} /><span>{group}</span><span className="dim">{items.length}</span></div>
                      {items.map((s, i) => renderSessionNode(s, i))}
                    </div>
                  ))}
                  {archivedCount > 0 ? (
                    <button className="show-more" onClick={() => setShowArchived((a) => !a)}>
                      {showArchived ? 'Hide archived' : `Show ${archivedCount} archived`}
                    </button>
                  ) : null}
                </div>
              </div>
              {otherProjects.map((w) => {
                const open = expandedProjects.includes(w);
                const list = projSessions[w];
                return (
                  <div key={w} className="project-block">
                    <button className="project-row" title={w} onClick={() => toggleProject(w)}>
                      <Icon name={open ? 'folder-open' : 'folder'} size={15} />
                      <span>{w.split('/').pop()}</span>
                      <span className="project-meta">
                        <span className="icon-btn project-open" title="Open this project here"
                          onClick={(ev) => { ev.stopPropagation(); openProject(w); }}>
                          <Icon name="arrow-right" size={12} />
                        </span>
                        <Icon name={open ? 'chev-down' : 'chev-right'} size={10} className="project-chev" />
                      </span>
                    </button>
                    {open ? (
                      <div className="project-sessions">
                        {list === undefined ? <div className="proj-empty">Loading…</div>
                          : list.length === 0 ? <div className="proj-empty">No chats yet</div>
                          : list.slice(0, 6).map((s) => (
                            <button key={s.sessionKey} className="project-session" title={`${s.sessionKey} — opens ${w.split('/').pop()}`}
                              onClick={() => openProject(w, s.sessionKey)}>
                              <SessionStatus s={s} />
                              <span className="session-title">{s.firstUserMessage || s.sessionKey}</span>
                              {s.modifiedAt ? <span className="session-age">{fmtAge(s.modifiedAt)}</span> : null}
                            </button>
                          ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <button className="project-row add-project" onClick={addProject}><Icon name="folder-plus" size={15} /><span>Add project</span></button>
            </div>
          {/* DESK-5m — plain identity row: Settings lives in the top-right
              gear and All commands in ⌘K, so no menu and no chevron here. */}
          <div className="account-row" title={workspaces.current ?? info.workspaceRoot}>
            <span className="avatar">{(info.username ?? 'br').slice(0, 2)}</span>
            <span className="account-name">{info.username ?? 'BrainRouter'}</span>
          </div>
          </div>
        </nav>
      ) : null}

      <div className="main">
        <div className="workrow" ref={workrowRef}>
          <main className={`center${homeMode ? ' home-mode' : ''}${railOpen ? '' : ' no-rail'}`}>
            <header className="chat-head">
              {!railOpen ? <button className="icon-btn" title="Open sidebar" onClick={() => setRailOpen(true)}><Icon name="layout" size={15} /></button> : null}
              <span className="crumb">
                <b>{gitInfo?.repo ?? info.workspaceRoot?.split('/').pop() ?? 'BrainRouter'}</b>
                <span className="crumb-sep">/</span>
                {taskView ? (
                  /* DESK-6v — viewing a sub-agent: ONE breadcrumb (no second header
                     bar). The parent session is clickable = back. */
                  <>
                    <button className="crumb-link" onClick={() => setTaskView(null)}>{sessionTitle}</button>
                    <span className="crumb-sep">/</span>
                    <span className="crumb-cur">{taskView.role || taskView.kind}</span>
                    {taskView.status ? <span className={`task-status ${taskView.status}`}>{taskView.status}</span> : null}
                  </>
                ) : sessionTitle}
              </span>
            </header>
            <div className="chat" ref={chatRef} onScroll={() => {
              const el = chatRef.current;
              if (!el) return;
              const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              atBottomRef.current = pinned;
              setAtBottom(pinned);
            }}>
              {workflowView ? (
                /* DESK-6w — the /workflows-style card for a workflow run. */
                <WorkflowCard wf={workflowView} onBack={() => setWorkflowView(null)} />
              ) : taskView ? (
                /* DESK-6v — a background task's conversation, read-only, in place
                   of the chat. The header breadcrumb (Repo / Session / Role +
                   status) now carries the title and back-link, so there's no
                   second header bar here — that double header was the confusing
                   part. The prompt is already the first user bubble. */
                <div className="task-convo">
                  {taskView.rows.map((r) => renderRow(r, false))}
                </div>
              ) : (
                <>
                  {homeMode ? (
                    <HomeView username={info.username} stats={homeStats} tab={statsTab} setTab={setStatsTab}
                      range={statsRange} setRange={setStatsRange} model={info.model} provider={snapshot?.provider}
                      repo={gitInfo?.repo ?? info.workspaceRoot?.split('/').pop()}
                      recents={sessions}
                      onResume={(key) => resumeSession(key)} />
                  ) : null}
                  {!homeMode && forkParent ? (
                    <button className="fork-banner" onClick={() => resumeSession(forkParent.key)}
                      title="Open the original conversation this was forked from">
                      <Icon name="branch" size={12} />
                      <span>Forked from <strong>{forkParent.title || 'conversation'}</strong></span>
                    </button>
                  ) : null}
                  {transcriptEls}
                </>
              )}
              {!taskView && !workflowView && liveText ? (
                <div className="row assistant md live">
                  <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{liveText}</Markdown>
                  <span className="caret">▍</span>
                </div>
              ) : null}
              {!taskView && !workflowView && running ? (
                <div className="row workline">
                  <span className="spinner sm" />
                  <WorkElapsed startedAt={turnStart} />
                  <span>·</span>
                  <span>{liveText ? 'writing…' : reasoningTail ? 'thinking…' : statusLine || 'working…'}</span>
                  {reasoningTail && !liveText ? <span className="reasoning"> {reasoningTail.slice(-90)}</span> : null}
                </div>
              ) : null}
              {!taskView && !workflowView && interaction && interaction.type === 'confirm' ? (
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
            {hasConversation && !atBottom ? (
              <button className="jump-latest" onClick={() => {
                atBottomRef.current = true;
                setAtBottom(true);
                chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
              }}>↓ Latest</button>
            ) : null}
            {hasConversation && gitInfo?.branch && (gitInfo.insertions + gitInfo.deletions > 0) ? (
              <div className="branchbar" onClick={() => ensurePanel('diff')}>
                <Icon name="diff" size={12} />
                <span><span className="add-n">+{gitInfo.insertions.toLocaleString()}</span> <span className="del-n">-{gitInfo.deletions.toLocaleString()}</span></span>
                <span className="dim">{changedFiles.length} files changed — view diff</span>
              </div>
            ) : null}
            <div className="composer">
              <div className="box">
                {slashActive && slashMatches.length ? (
                  <div className="slash-pop">
                    <SlashPopup commands={commands} filter={draft} selected={slashSel} onPick={runSlash} onHover={setSlashSel} />
                  </div>
                ) : null}
                <textarea
                  rows={1}
                  placeholder={stopping ? 'Stopping…' : running ? 'Working…' : 'Message BrainRouter…  ( / for commands )'}
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
                    if (e.key === 'Escape' && running) requestStop();
                  }}
                />
                <button className={`input-send icon-btn${running ? ' stop-red' : ''}${stopping ? ' stopping' : ''}`} title={stopping ? 'Stopping…' : running ? 'Stop' : 'Send'}
                  onClick={() => running ? requestStop() : submit()}
                  disabled={(!running && !draft.trim()) || stopping}>{running ? <Icon name="stop" size={14} /> : <Icon name="arrow-up" size={14} />}</button>
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
                    <button type="button" className="chip dim" onClick={() => setPop(pop === 'mode' ? '' : 'mode')}>
                      {modeLabel}<Icon name="chev-down" size={9} />
                    </button>
                  </span>
                  <button type="button" className="ctx-chip" title={info.workspaceRoot}>
                    <Icon name="folder" size={11} />
                    <span>{info.workspaceRoot?.split('/').pop() ?? 'workspace'}</span>
                  </button>
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
                      <button type="button" className="ctx-chip" onClick={() => setPop(pop === 'branch' ? '' : 'branch')}>
                        <Icon name="branch" size={11} />
                        <span>{branches.current}</span>
                        <Icon name="chev-down" size={9} />
                      </button>
                    ) : null}
                  </span>
                  <span className="composer-spacer" />
                  {/* DESK-5q — effort is its OWN control (Codex: Faster → Smarter) */}
                  <span className="pop-wrap">
                    {pop === 'effort' ? (
                      <div className="menu-pop effort-menu">
                        <div className="menu-head"><span>Effort</span><span>Faster → Smarter</span></div>
                        {EFFORT_LEVELS.map((lvl) => (
                          <button key={lvl} className="menu-item" onClick={() => { q('a-pref', 'action:set-pref', { key: 'effort', value: lvl }); setPop(''); }}>
                            <span className="mi-check">{effort === lvl ? '✓' : ''}</span>{lvl === 'xhigh' ? 'Extra high' : lvl[0].toUpperCase() + lvl.slice(1)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <button type="button" className="effort-pill" title="Reasoning effort" onClick={() => setPop(pop === 'effort' ? '' : 'effort')}>
                      {effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1)}
                    </button>
                  </span>
                  {/* model selection is now separate from effort */}
                  <span className="pop-wrap">
                    {pop === 'model' ? (
                      <div className="menu-pop model-menu">
                        {(() => {
                          // DESK-5l — only models that can actually chat;
                          // embedding/audio/rerank picks broke the session.
                          const chatModels = endpointModels.filter((m) => !NON_CHAT_MODEL.test(m));
                          const hidden = endpointModels.length - chatModels.length;
                          const listed = [...new Set([...(chatModels.length ? chatModels : []), ...modelChoices])];
                          return (
                            <>
                              <div className="menu-head"><span>Models{chatModels.length ? ` · ${chatModels.length} on endpoint` : ''}</span><span>⇧⌃I</span></div>
                              <div className="model-list">
                                {modelsLoading && !endpointModels.length ? (
                                  <div className="empty" style={{ padding: '4px 9px' }}>Loading models…</div>
                                ) : null}
                                {!modelsLoading && !endpointModels.length ? (
                                  <div className="empty" style={{ padding: '4px 9px' }}>Endpoint returned no models — check the connection in Settings.</div>
                                ) : null}
                                {listed.map((m, i) => (
                                  <button key={m} className="menu-item" onClick={() => {
                                    window.brainrouter.send({ kind: 'set-model', model: m, persist: true });
                                    setPop('');
                                  }}>
                                    <span className="mi-check">{m === info.model ? '✓' : ''}</span>{m}
                                    <span className="mi-hint">{i < 9 ? i + 1 : ''}</span>
                                  </button>
                                ))}
                              </div>
                              {hidden > 0 ? (
                                <div className="menu-head"><span>{hidden} non-chat model{hidden === 1 ? '' : 's'} hidden (embeddings, audio…)</span></div>
                              ) : null}
                            </>
                          );
                        })()}
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
                    <button type="button" className="model-pill" onClick={() => {
                      if (pop !== 'model') { setModelsLoading(true); q('q-models', 'list-models'); }
                      setPop(pop === 'model' ? '' : 'model');
                    }}>
                      {info.model ?? ''}{execMode === 'fast' ? ' · Fast' : ''}
                    </button>
                  </span>
                  {/* DESK-5s/5u — click the ring for a full context + usage
                      breakdown. Hidden on an empty/new chat: with no
                      conversation, the ring would only reflect the system-prompt
                      baseline, which reads as misleading "context used". */}
                  <span className="pop-wrap" style={hasConversation ? undefined : { display: 'none' }}>
                    {pop === 'ctx' ? (
                      <div className="menu-pop ctx-pop">
                        <div className="menu-head"><span>Context window</span></div>
                        {contextUsage && contextUsage.window > 0 ? (
                          <UsageBar label="Model window" value={contextUsage.used} total={contextUsage.window}
                            tone={contextUsage.used / contextUsage.window >= 0.9 ? 'var(--err)' : 'var(--accent)'} />
                        ) : null}
                        <UsageBar label="Until auto-compaction" value={contextUsage?.used ?? 0} total={contextUsage?.compactAt ?? 80000}
                          tone={(contextUsage?.pct ?? 0) >= 0.95 ? 'var(--err)' : (contextUsage?.pct ?? 0) >= 0.75 ? 'var(--warn)' : 'var(--accent)'} />
                        <div className="ctx-note">Above the auto-compact line, BrainRouter summarizes old history and the context resets — shared with the CLI (<code>cli.autoCompactTokens</code>).</div>
                        <div className="menu-sep" />
                        <div className="menu-head"><span>This session</span></div>
                        <div className="ctx-stats">
                          <div><b>{tokens ? tokens.promptTokens.toLocaleString() : '—'}</b><span>tokens in</span></div>
                          <div><b>{tokens ? tokens.completionTokens.toLocaleString() : '—'}</b><span>tokens out</span></div>
                          <div><b>{tokens?.turns ?? 0}</b><span>turns</span></div>
                        </div>
                        <button className="menu-item" onClick={() => { setPop(''); openSettings('observability'); }}>
                          <span className="mi-check" />Full usage breakdown<span className="mi-hint">→</span>
                        </button>
                      </div>
                    ) : null}
                    <button type="button" className="ctx-ring-btn" title="Context & usage" onClick={() => { if (pop !== 'ctx') q('q-ctx', 'context-usage'); setPop(pop === 'ctx' ? '' : 'ctx'); }}>
                      <ContextRing usage={contextUsage} />
                    </button>
                  </span>
                </div>
              </div>
            </div>
          </main>

          {/* DESK-5h — Environment as a LAYOUT COLUMN: the chat reflows next
              to it; it can never cover content. Yields via envRoom. */}
          {envAnim.mounted ? (
            <aside className={`env-col${envAnim.closing ? ' closing' : ''}`}>
              <div className="env-pop">
                <div className="env-head">
                  <span>Environment</span>
                  <button className="icon-btn" title="Settings" onClick={() => openSettings('general')}><Icon name="gear" size={13} /></button>
                </div>
                {/* Sections render only when they apply: git rows need a
                    repo, the checks row needs a finished turn. */}
                {gitInfo?.branch ? (
                  <button className="env-row" onClick={() => ensurePanel('diff')}>
                    <Icon name="diff" size={14} /><span>Changes</span>
                    {gitInfo.insertions + gitInfo.deletions > 0 ? <b>+{gitInfo.insertions.toLocaleString()} -{gitInfo.deletions.toLocaleString()}</b> : null}
                  </button>
                ) : null}
                <button className="env-row" onClick={() => setTermDockOpen(true)}>
                  <Icon name="monitor" size={14} /><span>Local</span><Icon name="chev-down" size={10} />
                </button>
                {gitInfo?.branch ? (
                  <>
                    <button className="env-row" onClick={() => q('q-branches', 'git-branches')}>
                      <Icon name="branch" size={14} /><span>{branches.current ?? gitInfo.branch}</span><Icon name="chev-down" size={10} />
                    </button>
                    <button className="env-row" onClick={() => ensurePanel('diff')}>
                      <Icon name="commit" size={14} /><span>Commit or push</span>
                    </button>
                    {commitSubjects[0] ? (
                      <div className="env-row inert"><Icon name="merge" size={14} /><span>{commitSubjects[0]}</span></div>
                    ) : null}
                  </>
                ) : null}
                {lastTurnFails === null ? null : lastTurnFails === 0 ? (
                  <div className="env-row inert checks-ok"><Icon name="check-circle" size={14} /><span>Checks successful</span></div>
                ) : (
                  <div className="env-row inert checks-bad"><Icon name="warn" size={14} /><span>{lastTurnFails} tool call{lastTurnFails === 1 ? '' : 's'} failed last turn</span></div>
                )}
                <div className="env-sep" />
                <div className="env-label">Background tasks{activeSessionTasks.length ? ` · ${activeSessionTasks.length}` : ''}</div>
                {activeSessionTasks.length === 0 ? (
                  <div className="env-row inert muted"><Icon name="tasks" size={14} /><span>Nothing running in this chat</span></div>
                ) : activeSessionTasks.slice(0, 4).map((f) => (
                  <button key={f.id} className="env-row" title={`${f.kind} · ${f.id} — open its conversation`} onClick={() => openTask(f)}>
                    <span className="st-branch"><Icon name="merge" size={13} /></span>
                    <span>{f.label}{f.worktree ? ' ⎇' : ''}</span>
                    {fmtElapsed(f.startedAt) ? <b>{fmtElapsed(f.startedAt)}</b> : <span className="st"><span className="spinner sm" /></span>}
                  </button>
                ))}
                {activeSessionTasks.length > 4 ? (
                  <button className="env-row muted" onClick={() => ensurePanel('tasks')}>
                    <span className="st-branch"><Icon name="tasks" size={13} /></span><span>and {activeSessionTasks.length - 4} more…</span>
                  </button>
                ) : null}
              </div>
            </aside>
          ) : null}

          {sideAnim.mounted ? (
            <aside className={`views-rail${sideAnim.closing ? ' closing' : ''}`} style={{ width: sideWidth }}>
              <div className="col-grip" title="Drag to resize · drag far right to hide"
                onPointerDown={(e) => {
                  e.preventDefault();
                  const startX = e.clientX;
                  const startW = sideWidth;
                  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
                  // DESK-5k — swipe-to-hide, mirroring the left rail's grip.
                  const move = (ev: PointerEvent) => {
                    const w = startW + (startX - ev.clientX);
                    if (w < 215) { up(); setSidePanelOpen(false); return; }
                    setSideWidth(Math.max(280, Math.min(760, w)));
                  };
                  window.addEventListener('pointermove', move);
                  window.addEventListener('pointerup', up);
                }} />
              {activeSideTab ? (
                <>
                  {/* DESK-5f — tabs, not windows: one view at a time, switchable */}
                  <div className="side-tabs">
                    {sideTabs.map((t) => (
                      <button key={t} className={`term-tab${t === activeSideTab ? ' active' : ''}`} onClick={() => setActiveSideTab(t)}>
                        <Icon name={PANEL_DEFS.find((d) => d.id === t)?.icon ?? 'file'} size={11} />
                        <span className="tab-label">{tabTitle(t)}</span>
                        <span className="icon-btn term-tab-x" onClick={(ev) => { ev.stopPropagation(); closeSideTab(t); }}><Icon name="close" size={9} /></span>
                      </button>
                    ))}
                    <span className="pop-wrap">
                      {pop === 'splus' ? (
                        /* right-aligned: opens INTO the panel — a left-aligned
                           menu runs past the window edge when the panel is
                           the rightmost column */
                        <div className="menu-pop down">
                          {VIEW_MENU.filter((v) => !sideTabs.includes(v.id)).map((v) => (
                            <button key={v.id} className="menu-item" onClick={() => { setPop(''); ensurePanel(v.id); }}>
                              <span className="mi-check"><Icon name={v.icon} size={13} /></span>{v.title}
                            </button>
                          ))}
                          <div className="menu-sep" />
                          <button className="menu-item" onClick={() => { setPop(''); openBottomDock(); }}>
                            <span className="mi-check"><Icon name="terminal" size={13} /></span>Terminal<span className="mi-hint">⌃`</span>
                          </button>
                        </div>
                      ) : null}
                      <button className="icon-btn" title="Add view" onClick={() => setPop(pop === 'splus' ? '' : 'splus')}><Icon name="plus" size={12} /></button>
                    </span>
                    <span className="composer-spacer" />
                    <button className="icon-btn" title="Close panel" onClick={() => setSidePanelOpen(false)}><Icon name="close" size={12} /></button>
                  </div>
                  <div className="side-body panel-body" key={activeSideTab}>{renderPanelBody(activeSideTab)}</div>
                </>
              ) : (
                /* DESK-5f — no tab yet: ask the user to choose a view (Codex) */
                <div className="side-chooser">
                  {([
                    { id: 'plan' as PanelId, title: 'Plan', hint: '⌃⇧G', icon: 'review',
                      badge: lastPlan?.items.length ? `${lastPlan.items.filter((it) => it.status === 'completed').length}/${lastPlan.items.length}` : '' },
                    { id: 'terminal' as PanelId, title: 'Terminal', hint: '⌃`', icon: 'terminal', badge: '' },
                    { id: 'files' as PanelId, title: 'Files', hint: '⌘P', icon: 'folder', badge: '' },
                    { id: 'diff' as PanelId, title: 'Changes', hint: '⇧⌘D', icon: 'diff',
                      badge: changedFiles.length ? String(changedFiles.length) : '' },
                    { id: 'tasks' as PanelId, title: 'Background tasks', hint: '', icon: 'tasks',
                      badge: activeSessionTasks.length ? String(activeSessionTasks.length) : '', live: activeSessionTasks.length > 0 },
                    { id: 'tools' as PanelId, title: 'Tool calls', hint: '', icon: 'bolt',
                      badge: toolLog.length ? String(toolLog.length) : '' },
                    { id: 'search' as PanelId, title: 'Search session', hint: '', icon: 'search', badge: '' },
                    { id: 'context' as PanelId, title: 'Context', hint: '', icon: 'layout-right', badge: '' },
                  ] as Array<{ id: PanelId; title: string; hint: string; icon: string; badge: string; live?: boolean }>).map((l) => (
                    <button key={l.id} className="side-launcher" onClick={() => openSideView(l.id)}>
                      <Icon name={l.icon} size={18} />
                      <span>{l.title}</span>
                      <span className="launcher-meta">
                        {l.live ? <span className="spinner sm" /> : null}
                        {l.badge ? <span className="launcher-badge">{l.badge}</span> : null}
                        {l.hint ? <kbd>{l.hint}</kbd> : null}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </aside>
          ) : null}
        </div>

        {dockAnim.mounted ? (
          <div className={`term-dock${dockAnim.closing ? ' closing' : ''}`} style={{ height: termDockHeight }}>
            <div className="term-dock-grip" title="Drag to resize terminal height"
              onPointerDown={(ev) => resizeTerminal(termDockHeight, ev.clientY, ev)} />
            <div className="term-tabs">
              {termTabs.map((t, i) => {
                const shellNo = termTabs.slice(0, i + 1).filter((x) => x.kind === 'shell').length;
                const manyShells = termTabs.filter((x) => x.kind === 'shell').length > 1;
                const label = t.kind === 'shell'
                  ? `${gitInfo?.repo ?? 'shell'}${manyShells ? ` ${shellNo}` : ''}`
                  : tabTitle(t.kind);
                const icon = t.kind === 'shell' ? 'terminal' : PANEL_DEFS.find((d) => d.id === t.kind)?.icon ?? 'file';
                return (
                  <button key={t.id} className={`term-tab${t.id === activeTerm ? ' active' : ''}`} onClick={() => setActiveTerm(t.id)}>
                    <Icon name={icon} size={11} />
                    <span className="tab-label">{label}</span>
                    <span className="icon-btn term-tab-x" onClick={(ev) => { ev.stopPropagation(); closeBottomTab(t.id); }}><Icon name="close" size={9} /></span>
                  </button>
                );
              })}
              <span className="pop-wrap">
                {pop === 'bplus' ? (
                  /* drops UP over the chat — the dock is short and sits at the
                     window edge, so a drop-down would run off-screen */
                  <div className="menu-pop left">
                    <button className="menu-item" onClick={() => { setPop(''); addBottomTab('shell'); }}>
                      <span className="mi-check"><Icon name="terminal" size={13} /></span>New terminal<span className="mi-hint">⌃`</span>
                    </button>
                    <div className="menu-sep" />
                    {VIEW_MENU.map((v) => (
                      <button key={v.id} className="menu-item" onClick={() => { setPop(''); addBottomTab(v.id); }}>
                        <span className="mi-check"><Icon name={v.icon} size={13} /></span>{v.title}
                      </button>
                    ))}
                  </div>
                ) : null}
                <button className="icon-btn" title="Add tab" onClick={() => setPop(pop === 'bplus' ? '' : 'bplus')}><Icon name="plus" size={12} /></button>
              </span>
              <span className="composer-spacer" />
              <button className="icon-btn" title="Hide panel (⌃`)" onClick={() => setTermDockOpen(false)}><Icon name="close" size={12} /></button>
            </div>
            <div className="term-dock-body">
              {termTabs.filter((t) => t.kind === 'shell').map((t) => (
                <div key={t.id} style={t.id === activeTerm ? { display: 'contents' } : { display: 'none' }}>
                  <TerminalPanel />
                </div>
              ))}
              {(() => {
                const active = termTabs.find((t) => t.id === activeTerm);
                return active && active.kind !== 'shell'
                  ? <div className="dock-view panel-body" key={active.id}>{renderPanelBody(active.kind)}</div>
                  : null;
              })()}
            </div>
          </div>
        ) : null}

        {/* DESK-5h — window control cluster, pinned top-right of the content
            area (absolute — visual position is unaffected by DOM order).
            MUST be the LAST child of .main: Electron builds drag regions in
            DOM order, so this cluster's no-drag rect has to subtract AFTER
            the chat-head's drag rect is added. Placed earlier, the drag
            region re-covers the buttons and swallows every click — the
            browser preview ignores app-region, which is why it only broke
            in the real Electron shell. */}
        <span className="topbar-right">
          {!homeMode && envRoom ? (
            <button type="button" className={`app-switcher${envOpen ? ' active' : ''}`} title="Environment" onClick={() => {
              if (!envOpen) { q('q-gitlog', 'git-log'); q('q-git', 'git-info'); q('q-branches', 'git-branches'); }
              setEnvOpen((o) => !o);
            }}>
              <Icon name="brain" size={15} />
              <Icon name="chev-down" size={11} />
            </button>
          ) : null}
          <button type="button" className={`top-toggle${termDockOpen ? ' active' : ''}`} title="Toggle bottom panel (⌃`)" onClick={() => setTermDockOpen((o) => !o)}><Icon name="layout-bottom" size={16} /></button>
          <button type="button" className={`top-toggle${sidePanelOpen ? ' active' : ''}`} title="Toggle side panel (⌥⌘B)" onClick={() => setSidePanelOpen((o) => !o)}><Icon name="sidebar-right" size={16} /></button>
          <button type="button" className="top-toggle" title="Export session" onClick={() => setPop(pop === 'export' ? '' : 'export')}><Icon name="export" size={15} /></button>
          <button type="button" className="top-toggle" title="Settings" onClick={() => openSettings('general')}><Icon name="gear" size={15} /></button>
        </span>
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
            <div className="dialog-title">Do you trust this folder?</div>
            <div className="set-desc" style={{ marginBottom: 10 }}>
              BrainRouter may read, write, and execute files in this project once it opens.
              Trusting adds it to your projects — its chats live in the sidebar alongside your other projects.
            </div>
            <pre className="dialog-detail">{trustAsk.root}</pre>
            <div className="dialog-actions">
              <button className="deny" onClick={() => setTrustAsk(null)}>Cancel</button>
              <button className="approve" autoFocus onClick={() => {
                // T1 — persist trust in the shared CLI store (main enforces it),
                // not renderer localStorage. Optimistically show the project now.
                const root = trustAsk.root, resume = trustAsk.resume;
                setTrustAsk(null);
                void window.brainrouter.trustWorkspace(root).then(() => switchToWorkspace(root, resume));
              }}>Trust & open</button>
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

      {/* DESK-6m — per-chat ⋮ context menu (Open PR / Open in / Pin / Mark
          completed / Rename / Fork / Move to group / Archive / Delete). */}
      {sessionMenu ? (() => {
        const s = sessions.find((x) => x.sessionKey === sessionMenu.key);
        if (!s) return null;
        return (
          <>
            <div className="menu-scrim" onClick={closeSessionMenu} onContextMenu={(e) => { e.preventDefault(); closeSessionMenu(); }} />
            <div className="ctx-menu" style={{ left: sessionMenu.x, top: sessionMenu.y }} onClick={(e) => e.stopPropagation()}>
              <button className="ctx-item" onClick={() => openExternal('pr')}><Icon name="merge" size={13} /><span>Open PR</span><span className="ctx-key">G</span></button>
              <div className="ctx-sub">
                <button className="ctx-item"><Icon name="external" size={13} /><span>Open in</span><span className="ctx-key"><Icon name="chev-right" size={10} /></span></button>
                <div className="ctx-flyout">
                  <button className="ctx-item" onClick={() => openExternal('editor')}><span>Editor</span></button>
                  <button className="ctx-item" onClick={() => openExternal('finder')}><span>Finder</span></button>
                  <button className="ctx-item" onClick={() => openExternal('terminal')}><span>Terminal</span></button>
                </div>
              </div>
              <div className="ctx-sep" />
              <button className="ctx-item" onClick={() => togglePin(s)}><Icon name="pin" size={13} /><span>{s.pinned ? 'Unpin' : 'Pin'}</span><span className="ctx-key">P</span></button>
              <button className="ctx-item" onClick={() => toggleComplete(s)}><Icon name="check-circle" size={13} /><span>{s.status === 'completed' ? 'Mark as active' : 'Mark as completed'}</span><span className="ctx-key">U</span></button>
              <button className="ctx-item" onClick={() => startRename(s)}><Icon name="edit" size={13} /><span>Rename</span><span className="ctx-key">R</span></button>
              <button className="ctx-item" onClick={() => forkSessionAction(s.sessionKey)}><Icon name="fork" size={13} /><span>Fork</span><span className="ctx-key">F</span></button>
              <div className="ctx-sub">
                <button className="ctx-item"><Icon name="folder" size={13} /><span>Move to group</span><span className="ctx-key"><Icon name="chev-right" size={10} /></span></button>
                <div className="ctx-flyout">
                  {sessionGroups.map((g) => (
                    <button key={g} className="ctx-item" onClick={() => moveToGroup(s.sessionKey, g)}><span>{g}</span>{s.group === g ? <span className="ctx-key">✓</span> : null}</button>
                  ))}
                  {s.group ? <button className="ctx-item" onClick={() => moveToGroup(s.sessionKey, null)}><span>Ungroup</span></button> : null}
                  <button className="ctx-item" onClick={() => { const g = window.prompt('New group name'); if (g && g.trim()) moveToGroup(s.sessionKey, g.trim()); }}><span>New group…</span><span className="ctx-key">1</span></button>
                </div>
              </div>
              <div className="ctx-sep" />
              <button className="ctx-item" onClick={() => toggleArchive(s)}><Icon name="archive" size={13} /><span>{s.archived ? 'Unarchive' : 'Archive'}</span><span className="ctx-key">A</span></button>
              <button className="ctx-item danger" onClick={() => deleteSessionAction(s.sessionKey)}><Icon name="trash" size={13} /><span>Delete</span><span className="ctx-key">D</span></button>
            </div>
          </>
        );
      })() : null}
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
