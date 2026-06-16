/**
 * DESK-4c — the panel system: togglable, closeable panels that open as
 * full-height resizable window columns right of the chat (File · Files ·
 * Diff · Terminal · Tool calls · Background tasks · Plan · Context ·
 * Search). Each panel is a dumb component over App-owned state; the App
 * owns column widths and the drag-to-resize grips.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Prism } from 'react-syntax-highlighter';
import { Icon } from './icons.js';
import { partitionSchedules, describeSchedule, relTime, type ScheduleRecordView } from './scheduleView.js';
import { type WorktreeEntry } from './worktreeParser.js';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

// Same @types/react clash as react-markdown — runtime component is fine.
const Highlighter = Prism as unknown as React.ComponentType<Record<string, unknown>>;

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'scss', html: 'markup', md: 'markdown', py: 'python',
  go: 'go', rs: 'rust', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', sql: 'sql', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby',
};

export function langForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? 'text';
}

/** Theme-matched code block: transparent bg, our mono var, dim gutter. */
export function CodeBlock({ code, language, showLineNumbers }: {
  code: string;
  language: string;
  showLineNumbers?: boolean;
}): React.ReactElement {
  return (
    <Highlighter
      language={language}
      style={oneDark}
      showLineNumbers={showLineNumbers}
      customStyle={{ background: 'transparent', margin: 0, padding: 0, fontSize: '12px', lineHeight: '1.55' }}
      codeTagProps={{ style: { fontFamily: 'var(--mono)', fontSize: '12px' } }}
      lineNumberStyle={{ minWidth: '38px', paddingRight: '14px', color: 'var(--text-faint)', userSelect: 'none' }}
    >
      {code}
    </Highlighter>
  );
}

export type PanelId = 'context' | 'files' | 'file' | 'diff' | 'terminal' | 'tools' | 'tasks' | 'plan' | 'search' | 'schedule' | 'worktrees';

export const PANEL_DEFS: Array<{ id: PanelId; title: string; icon: string }> = [
  { id: 'context', title: 'Context', icon: 'layout-right' },
  { id: 'files', title: 'Files', icon: 'folder' },
  { id: 'file', title: 'File', icon: 'file' },
  { id: 'diff', title: 'Changes', icon: 'diff' },
  { id: 'terminal', title: 'Terminal', icon: 'terminal' },
  { id: 'tools', title: 'Tool calls', icon: 'bolt' },
  { id: 'tasks', title: 'Background tasks', icon: 'tasks' },
  { id: 'plan', title: 'Plan', icon: 'plan' },
  { id: 'search', title: 'Search session', icon: 'search' },
  { id: 'schedule', title: 'Schedules', icon: 'clock' },
  { id: 'worktrees', title: 'Worktrees', icon: 'branch' },
];

export function Panel({ title, onClose, children, actions }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">{title}</span>
        <span className="panel-actions">{actions}<button className="icon-btn" title="Close" onClick={onClose}><Icon name="close" size={12} /></button></span>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function PanelPicker({ open, onToggle }: {
  open: PanelId[];
  onToggle: (id: PanelId) => void;
}): React.ReactElement {
  const [menu, setMenu] = useState(false);
  const SHORTCUTS: Partial<Record<PanelId, string>> = { diff: '⇧⌘D', terminal: '⌃`', files: '⇧⌘F' };
  return (
    <div className="picker">
      <button className="chip chip-ic" onClick={() => setMenu((m) => !m)} title="Views"><Icon name="layout-right" size={13} /> Views</button>
      {menu ? (
        <>
          <div className="picker-backdrop" onClick={() => setMenu(false)} />
          <div className="picker-menu">
            {PANEL_DEFS.map((d) => (
              <button key={d.id} className="picker-item" onClick={() => onToggle(d.id)}>
                <span className="picker-check">{open.includes(d.id) ? '✓' : ''}</span>
                <span className="picker-icon"><Icon name={d.icon} size={14} /></span>{d.title}
                {SHORTCUTS[d.id] ? <span className="picker-hint">{SHORTCUTS[d.id]}</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface GrepHit { file: string; line: number; snippet: string }

// DESK-5c — VS Code-style folder tree built from the flat git file list.
interface TreeDir { dirs: Map<string, TreeDir>; files: string[] }

export function buildFileTree(paths: string[]): TreeDir {
  const root: TreeDir = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) { next = { dirs: new Map(), files: [] }; node.dirs.set(parts[i], next); }
      node = next;
    }
    node.files.push(parts[parts.length - 1]);
  }
  return root;
}

function TreeLevel({ dir, base, depth, expanded, onToggle, onOpen, statuses }: {
  dir: TreeDir;
  base: string;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  statuses: Map<string, string>;
}): React.ReactElement {
  const dirNames = [...dir.dirs.keys()].sort();
  const fileNames = [...dir.files].sort();
  return (
    <>
      {dirNames.map((name) => {
        const full = base ? `${base}/${name}` : name;
        const open = expanded.has(full);
        return (
          <React.Fragment key={full}>
            <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onToggle(full)}>
              <span className="tree-chevron"><Icon name={open ? 'chev-down' : 'chev-right'} size={10} /></span>
              <span className="tree-folder"><Icon name={open ? 'folder-open' : 'folder'} size={13} /></span>
              <span className="file-name">{name}</span>
            </div>
            {open ? (
              <TreeLevel dir={dir.dirs.get(name)!} base={full} depth={depth + 1}
                expanded={expanded} onToggle={onToggle} onOpen={onOpen} statuses={statuses} />
            ) : null}
          </React.Fragment>
        );
      })}
      {fileNames.map((name) => {
        const full = base ? `${base}/${name}` : name;
        return (
          <div key={full} className="tree-row file" style={{ paddingLeft: 8 + depth * 14 + 14 }}
            onClick={() => onOpen(full)} title={full}>
            <span className="file-name">{name}</span>
            {statuses.has(full) ? <span className={`fstat s-${(statuses.get(full) ?? '').replace('?', 'u')}`}>{statuses.get(full)}</span> : null}
          </div>
        );
      })}
    </>
  );
}

export function FilesPanel({ files, statuses, onOpen, grepHits, onGrep }: {
  files: string[];
  statuses: Map<string, string>;
  onOpen: (path: string) => void;
  grepHits: GrepHit[] | null;
  onGrep: (q: string) => void;
}): React.ReactElement {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildFileTree(files), [files]);
  const contentMode = filter.startsWith('?');
  const shown = useMemo(() => {
    if (contentMode) return [];
    const q = filter.trim().toLowerCase();
    const list = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
    return list.slice(0, 400);
  }, [files, filter, contentMode]);
  return (
    <>
      <input className="filter" placeholder="Filter files… (?text to search contents)" value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && contentMode && filter.slice(1).trim()) onGrep(filter.slice(1).trim()); }} />
      <div className="scroll">
        {contentMode ? (
          grepHits === null ? <div className="empty">Press Enter to search file contents.</div>
            : grepHits.length === 0 ? <div className="empty center-empty">No matches</div>
            : grepHits.map((h, i) => (
              <div key={i} className="grep-hit" onClick={() => onOpen(h.file)}>
                <div className="grep-file">{h.file}:{h.line}</div>
                <div className="grep-snippet">{h.snippet}</div>
              </div>
            ))
        ) : files.length === 0 ? (
          <div className="empty center-empty">Folder is empty</div>
        ) : !filter.trim() ? (
          <TreeLevel dir={tree} base="" depth={0} expanded={expanded}
            onToggle={(path) => setExpanded((e) => { const n = new Set(e); if (n.has(path)) n.delete(path); else n.add(path); return n; })}
            onOpen={onOpen} statuses={statuses} />
        ) : (
          <>
            {shown.map((f) => (
              <div key={f} className="file-row" onClick={() => onOpen(f)} title={f}>
                <span className={`fstat ${statuses.has(f) ? 's-' + (statuses.get(f) ?? '').replace('?', 'u') : ''}`}>{statuses.get(f) ?? ''}</span>
                <span className="file-name">{f}</span>
              </div>
            ))}
            {shown.length === 0 ? <div className="empty">No matches.</div> : null}
          </>
        )}
      </div>
    </>
  );
}

export function FileViewerPanel({ view }: {
  view: { path: string; content: string; error?: string } | null;
}): React.ReactElement {
  if (!view) return <div className="empty">Open a file from the Files panel or a diff.</div>;
  if (view.error) return <div className="empty">✗ {view.error}</div>;
  return (
    <>
      <div className="pathbar" title={view.path}>
        <span className="path-text">{view.path}</span>
        <button className="icon-btn" title="Copy contents" onClick={() => void navigator.clipboard.writeText(view.content)}><Icon name="copy" size={13} /></button>
      </div>
      <div className="scroll code-view">
        <CodeBlock code={view.content} language={langForPath(view.path)} showLineNumbers />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// DESK-4h — the inspect-diff: unified-diff parser + per-hunk cards (observed:
// clicking "Edited f +6 -4" expands hunk cards with a path bar, line-number
// gutter, and red/green tinted blocks).

export interface DiffLine { type: 'ctx' | 'add' | 'del' | 'meta'; oldNo: number | null; newNo: number | null; text: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface DiffFile { path: string; hunks: DiffHunk[]; adds: number; dels: number }

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0, newNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      file = { path: '', hunks: [], adds: 0, dels: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '').trim();
      if (!file) { file = { path: '', hunks: [], adds: 0, dels: 0 }; files.push(file); }
      if (p !== '/dev/null') file.path = p;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4).replace(/^a\//, '').trim();
      if (file && !file.path && p !== '/dev/null') file.path = p;
      continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) {
      if (!file) { file = { path: '', hunks: [], adds: 0, dels: 0 }; files.push(file); }
      oldNo = Number(m[1]); newNo = Number(m[2]);
      hunk = { header: m[3].trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk || !file) continue;
    if (line.startsWith('+')) { hunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) }); file.adds++; }
    else if (line.startsWith('-')) { hunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) }); file.dels++; }
    else if (line.startsWith('\\')) { hunk.lines.push({ type: 'meta', oldNo: null, newNo: null, text: line }); }
    else { hunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.startsWith(' ') ? line.slice(1) : line }); }
  }
  return files.filter((f) => f.hunks.length);
}

export function DiffView({ diff }: { diff: string }): React.ReactElement {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (!files.length) return <div className="empty center-empty">No changes to show</div>;
  return (
    <div className="diffview">
      {files.map((f, fi) => f.hunks.map((h, hi) => (
        <div key={`${fi}-${hi}`} className="hunk-card">
          <div className="hunk-path" title={f.path}>
            <span className="path-text">{f.path}{h.header ? `  ·  ${h.header}` : ''}</span>
            {hi === 0 ? <span className="hunk-stats"><span className="add-n">+{f.adds}</span> <span className="del-n">-{f.dels}</span></span> : null}
          </div>
          <div className="hunk-lines">
            {h.lines.map((l, li) => (
              <div key={li} className={`hunk-line ${l.type}`}>
                <span className="hno">{l.oldNo ?? ''}</span>
                <span className="hno">{l.newNo ?? ''}</span>
                <span className="hmark">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
                <span className="htext">{l.text || ' '}</span>
              </div>
            ))}
          </div>
        </div>
      )))}
    </div>
  );
}

export function DiffPanel({ gitInfo, changed, diff, onPick, onBack, onOpenFile, onGit, gitBusy }: {
  gitInfo: { repo: string; branch: string | null; insertions: number; deletions: number } | null;
  changed: Array<{ status: string; path: string }>;
  diff: { path: string; diff: string } | null;
  onPick: (path: string) => void;
  onBack: () => void;
  onOpenFile: (path: string) => void;
  /** DESK-5j — the review surface acts on git: commit all / push / pull. */
  onGit?: (kind: 'commit' | 'push' | 'pull', msg?: string) => void;
  gitBusy?: boolean;
}): React.ReactElement {
  const [msg, setMsg] = useState('');
  const commit = () => { if (msg.trim() && changed.length) { onGit?.('commit', msg.trim()); setMsg(''); } };
  return (
    <>
      {gitInfo?.branch ? (
        <div className="gitbar">
          <span className="gitbranch"><Icon name="branch" size={12} /> {gitInfo.branch}</span>
          {gitInfo.insertions + gitInfo.deletions > 0 ? (
            <span><span className="add-n">+{gitInfo.insertions.toLocaleString()}</span> <span className="del-n">-{gitInfo.deletions.toLocaleString()}</span></span>
          ) : <span className="dim">clean</span>}
        </div>
      ) : null}
      {onGit && gitInfo?.branch && !diff ? (
        <div className="review-actions">
          <input className="filter commit-msg" placeholder={changed.length ? 'Commit message' : 'Working tree clean'}
            value={msg} disabled={!changed.length || gitBusy}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
          <button className="btn" disabled={!changed.length || !msg.trim() || gitBusy} onClick={commit}>Commit</button>
          <button className="btn" disabled={gitBusy} onClick={() => onGit('push')}>Push</button>
          <button className="btn" disabled={gitBusy} onClick={() => onGit('pull')}>Pull</button>
        </div>
      ) : null}
      {diff ? (
        <>
          <button className="backlink" onClick={onBack}>← {diff.path}</button>
          <div className="scroll">
            <DiffView diff={diff.diff} />
          </div>
        </>
      ) : (
        <div className="scroll">
          {changed.length === 0 ? <div className="empty center-empty">No changes to show</div> : changed.map((f) => (
            <div key={f.path} className="file-row" title={f.path}>
              <span className={`fstat s-${f.status.replace('?', 'u')}`}>{f.status}</span>
              <span className="file-name" onClick={() => onPick(f.path)}>{f.path}</span>
              <button className="icon-btn" title="Open file" onClick={() => onOpenFile(f.path)}><Icon name="file" size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * DESK-5c — the real terminal: a persistent host-side shell session
 * rendered through xterm. The panel owns its bridge round-trips directly
 * (query ids namespaced per mount) and polls term-read on a 200ms cadence.
 */
export function TerminalPanel(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [dead, setDead] = useState(false);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace';
    const styles = getComputedStyle(document.documentElement);
    const term = new Terminal({
      fontFamily: mono,
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: styles.getPropertyValue('--term-bg').trim() || '#121212',
        foreground: styles.getPropertyValue('--text').trim() || '#ececec',
        cursor: styles.getPropertyValue('--brand').trim() || '#d97757',
        selectionBackground: 'rgba(255,255,255,0.18)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const ns = `term${Math.random().toString(36).slice(2, 8)}`;
    let termId = '';
    let next = 0;
    const off = window.brainrouter.onEvent((msg) => {
      const e = msg.event as { kind: string; id?: string; ok?: boolean; result?: { id?: string; chunk?: string; next?: number; alive?: boolean } };
      if (e.kind !== 'query-result' || !e.id?.startsWith(ns)) return;
      if (e.id === `${ns}:open` && e.ok && e.result?.id) { termId = e.result.id; return; }
      if (e.id === `${ns}:read` && e.ok && e.result) {
        if (e.result.chunk) term.write(e.result.chunk);
        next = e.result.next ?? next;
        if (e.result.alive === false) setDead(true);
      }
    });
    window.brainrouter.send({ kind: 'query', id: `${ns}:open`, name: 'term-open' });
    const data = term.onData((d) => {
      if (termId) window.brainrouter.send({ kind: 'query', id: `${ns}:w`, name: 'term-write', args: { id: termId, data: d } });
    });
    const poll = setInterval(() => {
      if (termId) window.brainrouter.send({ kind: 'query', id: `${ns}:read`, name: 'term-read', args: { id: termId, from: next } });
    }, 200);
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* detached */ } });
    ro.observe(el);
    return () => {
      clearInterval(poll);
      ro.disconnect();
      data.dispose();
      off();
      if (termId) window.brainrouter.send({ kind: 'query', id: `${ns}:kill`, name: 'term-kill', args: { id: termId } });
      term.dispose();
    };
  }, []);
  return (
    <div className="xterm-wrap">
      <div className="xterm-host" ref={hostRef} />
      {dead ? <div className="empty">Shell exited — close and reopen the Terminal view to restart it.</div> : null}
    </div>
  );
}

export function ToolsPanel({ log }: { log: Array<{ id: number; tool: string; ok: boolean; summary: string }> }): React.ReactElement {
  return (
    <div className="scroll">
      {log.length === 0 ? <div className="empty">No tool calls yet.</div> : log.slice().reverse().map((t) => (
        <div key={t.id} className="toollog-row"><span className={t.ok ? 'okdot' : 'faildot'} />{t.tool} — {t.summary}</div>
      ))}
    </div>
  );
}

export interface FinishedTask { id: string; label: string; status: string }

export function TasksPanel({ fleet, finished, onClear, onOpen }: {
  fleet: Array<{ kind: string; id: string; label: string }>;
  finished: FinishedTask[];
  onClear: () => void;
  /** DESK-5w — open a running task's conversation (read-only). */
  onOpen?: (id: string) => void;
}): React.ReactElement {
  return (
    <div className="scroll">
      <div className="tasks-section"><span>Running in this chat</span></div>
      {fleet.length === 0 ? <div className="empty">Nothing running in this chat.</div> : fleet.map((f) => (
        <button key={f.id} className="task-row clickable" onClick={() => onOpen?.(f.id)} title="Open this task's conversation">
          <span className="task-kind">{f.kind}</span><span className="file-name">{f.label}</span><span className="task-open">→</span>
        </button>
      ))}
      <div className="tasks-section"><span>Finished</span>{finished.length ? <button className="tasks-clear" onClick={onClear}>Clear</button> : null}</div>
      {finished.length === 0 ? <div className="empty">Nothing finished yet.</div> : finished.map((f) => (
        <div key={f.id}>
          <div className="task-row"><span className="session-dot" /><span className="file-name">{f.label}</span></div>
          <div className="task-status">{f.status}</div>
        </div>
      ))}
    </div>
  );
}

export function SchedulePanel({ schedules, now, onAdd, onRemove, onToggle }: {
  schedules: ScheduleRecordView[];
  now: number;
  onAdd: (kind: 'cron' | 'once', expr: string, command: string) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}): React.ReactElement {
  const [kind, setKind] = useState<'cron' | 'once'>('cron');
  const [expr, setExpr] = useState('');
  const [command, setCommand] = useState('');
  const { active, disabled } = partitionSchedules(schedules);
  const submit = (): void => {
    if (!expr.trim() || !command.trim()) return;
    onAdd(kind, expr.trim(), command.trim().startsWith('/') ? command.trim() : `/${command.trim()}`);
    setExpr(''); setCommand('');
  };
  const row = (r: ScheduleRecordView): React.ReactElement => (
    <div key={r.id} className={`sched-row${r.enabled ? '' : ' off'}`}>
      <button className="sched-toggle" title={r.enabled ? 'Disable' : 'Enable'} onClick={() => onToggle(r.id, !r.enabled)}>
        <span className={`session-dot${r.enabled ? ' on' : ''}`} />
      </button>
      <div className="sched-main">
        <div className="sched-cmd">{r.command}</div>
        <div className="sched-meta">{describeSchedule(r)} · {r.enabled ? `fires ${relTime(r.nextRun, now)}` : 'paused'}{r.lastRun ? ` · last ${relTime(r.lastRun, now)}` : ''}</div>
      </div>
      <button className="icon-btn" title="Remove" onClick={() => onRemove(r.id)}><Icon name="close" size={11} /></button>
    </div>
  );
  return (
    <div className="scroll sched-panel">
      <div className="sched-add">
        <div className="sched-add-row">
          <button className={`seg-toggle${kind === 'cron' ? ' active' : ''}`} onClick={() => setKind('cron')}>cron</button>
          <button className={`seg-toggle${kind === 'once' ? ' active' : ''}`} onClick={() => setKind('once')}>once</button>
          <input className="filter" placeholder={kind === 'cron' ? '*/15 * * * *' : '2026-06-16T15:30'} value={expr} onChange={(e) => setExpr(e.target.value)} />
        </div>
        <div className="sched-add-row">
          <input className="filter" placeholder="/status   (slash command to run)" value={command} onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <button className="sched-add-btn" onClick={submit}>Add</button>
        </div>
      </div>
      <div className="tasks-section"><span>Active</span></div>
      {active.length === 0 ? <div className="empty">No active schedules.</div> : active.map(row)}
      {disabled.length ? <><div className="tasks-section"><span>Paused</span></div>{disabled.map(row)}</> : null}
      <div className="sched-note">Schedules persist in <code>.brainrouter/schedules.json</code> — shared with the CLI <code>/schedule</code>. They fire while the CLI agent runs.</div>
    </div>
  );
}

export function WorktreesPanel({ worktrees, diffs, onCreate, onRemove, onOpen, onDiff }: {
  worktrees: WorktreeEntry[];
  diffs: Record<string, string>;
  onCreate: (name: string, ref: string) => void;
  onRemove: (path: string) => void;
  onOpen: (path: string) => void;
  onDiff: (path: string) => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [ref, setRef] = useState('');
  const [openPath, setOpenPath] = useState<string | null>(null);
  const submit = (): void => { if (name.trim()) { onCreate(name.trim(), ref.trim()); setName(''); setRef(''); } };
  const toggleDiff = (p: string): void => {
    const next = openPath === p ? null : p;
    setOpenPath(next);
    if (next && diffs[next] === undefined) onDiff(next);
  };
  return (
    <div className="scroll wt-panel">
      <div className="sched-add">
        <div className="sched-add-row">
          <input className="filter" placeholder="new worktree name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="filter" placeholder="base ref (HEAD)" value={ref} onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <button className="sched-add-btn" onClick={submit}>Add</button>
        </div>
      </div>
      {worktrees.length === 0 ? <div className="empty">No worktrees. The main checkout plus any you add appear here.</div> : worktrees.map((w) => (
        <div key={w.path} className="wt-row">
          <div className="wt-head">
            <Icon name="branch" size={13} />
            <span className="wt-branch">{w.isDetached ? '(detached)' : w.branch || '—'}</span>
            {w.isMain ? <span className="wt-tag">main</span> : null}
            {w.isCurrent ? <span className="wt-tag cur">open</span> : null}
          </div>
          <div className="wt-path" title={w.path}>{w.path}</div>
          <div className="wt-actions">
            {!w.isCurrent ? <button className="wt-btn" onClick={() => onOpen(w.path)}>Open</button> : null}
            <button className="wt-btn" onClick={() => toggleDiff(w.path)}>{openPath === w.path ? 'Hide diff' : 'Diff'}</button>
            {!w.isMain ? <button className="wt-btn danger" onClick={() => onRemove(w.path)}>Remove</button> : null}
          </div>
          {openPath === w.path ? (
            <div className="wt-diff">
              {diffs[w.path] === undefined ? <div className="empty">Loading diff…</div>
                : diffs[w.path].trim() ? <DiffView diff={diffs[w.path]} />
                : <div className="empty">No uncommitted changes in this worktree.</div>}
            </div>
          ) : null}
        </div>
      ))}
      <div className="sched-note">Worktrees are sibling checkouts under <code>.worktrees/</code> — run an agent in one without touching your main checkout. “Open” switches this window to it.</div>
    </div>
  );
}

export interface SearchHit { index: number; role: string; snippet: string }

export function SearchPanel({ hits, onSearch }: {
  hits: SearchHit[] | null;
  onSearch: (q: string) => void;
}): React.ReactElement {
  const [q, setQ] = useState('');
  return (
    <>
      <input className="filter" placeholder="Search this session…  (Enter)" value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) onSearch(q.trim()); }} />
      <div className="scroll">
        {hits === null ? <div className="empty">Searches the persisted transcript — same as /find in the CLI.</div>
          : hits.length === 0 ? <div className="empty">No matches.</div>
          : hits.map((h, i) => (
            <div key={i} className="search-hit">
              <div className="search-role">{h.role} · #{h.index}</div>
              <div className="search-snippet">{h.snippet}</div>
            </div>
          ))}
      </div>
    </>
  );
}

export function PlanPanel({ plan }: {
  plan: { items: Array<{ step: string; status: string; acceptance?: string }>; explanation?: string } | null;
}): React.ReactElement {
  if (!plan || plan.items.length === 0) {
    return (
      <div className="empty center-empty panel-empty">
        <Icon name="plan" size={18} />
        <div>No plan yet</div>
        <span className="dim">The agent writes its plan here as it works.</span>
      </div>
    );
  }
  return (
    <div className="scroll">
      {plan.explanation ? <div className="plan-why">{plan.explanation}</div> : null}
      {plan.items.map((it, i) => (
        <div key={i} className={`plan-item ${it.status}`}>
          <span className="plan-mark">{it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '◐' : '○'}</span>
          <span className="plan-step">{it.step}{it.acceptance ? <span className="plan-acceptance">✓ {it.acceptance}</span> : null}</span>
        </div>
      ))}
    </div>
  );
}
