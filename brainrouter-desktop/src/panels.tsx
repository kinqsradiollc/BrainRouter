/**
 * DESK-4c — the panel system: togglable, closeable panels that open as
 * full-height resizable window columns right of the chat (File · Files ·
 * Diff · Terminal · Tool calls · Background tasks · Plan · Context ·
 * Search). Each panel is a dumb component over App-owned state; the App
 * owns column widths and the drag-to-resize grips.
 */
import React, { useMemo, useState } from 'react';
import { Prism } from 'react-syntax-highlighter';
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

export type PanelId = 'context' | 'files' | 'file' | 'diff' | 'terminal' | 'tools' | 'tasks' | 'plan' | 'search';

export const PANEL_DEFS: Array<{ id: PanelId; title: string; icon: string }> = [
  { id: 'context', title: 'Context', icon: '◳' },
  { id: 'files', title: 'Files', icon: '🗂' },
  { id: 'file', title: 'File', icon: '📄' },
  { id: 'diff', title: 'Diff', icon: '±' },
  { id: 'terminal', title: 'Terminal', icon: '❯' },
  { id: 'tools', title: 'Tool calls', icon: '⚙' },
  { id: 'tasks', title: 'Background tasks', icon: '◐' },
  { id: 'plan', title: 'Plan', icon: '☰' },
  { id: 'search', title: 'Search session', icon: '🔎' },
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
        <span className="panel-actions">{actions}<button className="icon-btn" title="Close" onClick={onClose}>✕</button></span>
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
      <button className="chip" onClick={() => setMenu((m) => !m)} title="Views">⊞ Views</button>
      {menu ? (
        <>
          <div className="picker-backdrop" onClick={() => setMenu(false)} />
          <div className="picker-menu">
            {PANEL_DEFS.map((d) => (
              <button key={d.id} className="picker-item" onClick={() => onToggle(d.id)}>
                <span className="picker-check">{open.includes(d.id) ? '✓' : ''}</span>
                <span className="picker-icon">{d.icon}</span>{d.title}
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

export function FilesPanel({ files, statuses, onOpen, grepHits, onGrep }: {
  files: string[];
  statuses: Map<string, string>;
  onOpen: (path: string) => void;
  grepHits: GrepHit[] | null;
  onGrep: (q: string) => void;
}): React.ReactElement {
  const [filter, setFilter] = useState('');
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
        <button className="icon-btn" title="Copy contents" onClick={() => void navigator.clipboard.writeText(view.content)}>🗗</button>
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

export function DiffPanel({ gitInfo, changed, diff, onPick, onBack, onOpenFile }: {
  gitInfo: { repo: string; branch: string | null; insertions: number; deletions: number } | null;
  changed: Array<{ status: string; path: string }>;
  diff: { path: string; diff: string } | null;
  onPick: (path: string) => void;
  onBack: () => void;
  onOpenFile: (path: string) => void;
}): React.ReactElement {
  return (
    <>
      {gitInfo?.branch ? (
        <div className="gitbar">
          <span className="gitbranch">⎇ {gitInfo.branch}</span>
          {gitInfo.insertions + gitInfo.deletions > 0 ? (
            <span><span className="add-n">+{gitInfo.insertions.toLocaleString()}</span> <span className="del-n">-{gitInfo.deletions.toLocaleString()}</span></span>
          ) : <span className="dim">clean</span>}
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
              <button className="icon-btn" title="Open file" onClick={() => onOpenFile(f.path)}>↗</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function TerminalPanel({ lines, onExec }: { lines: string[]; onExec: (cmd: string) => void }): React.ReactElement {
  const [cmd, setCmd] = useState('');
  const histRef = React.useRef<string[]>([]);
  const histIdx = React.useRef(-1);
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'auto' }); }, [lines.length]);
  return (
    <>
      <pre className="term scroll">{lines.length ? lines.join('\n') : 'Run a command below, or watch run_command / background output here.'}<div ref={endRef} /></pre>
      <div className="term-input-row">
        <span className="prompt-ch">❯</span>
        <input value={cmd} placeholder="Run a command in the workspace…  (↑ history)" spellCheck={false}
          onChange={(e) => { setCmd(e.target.value); histIdx.current = -1; }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && cmd.trim()) {
              histRef.current = [cmd.trim(), ...histRef.current.slice(0, 49)];
              histIdx.current = -1;
              onExec(cmd.trim());
              setCmd('');
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              const next = Math.min(histIdx.current + 1, histRef.current.length - 1);
              if (histRef.current[next] !== undefined) { histIdx.current = next; setCmd(histRef.current[next]); }
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              const next = histIdx.current - 1;
              if (next < 0) { histIdx.current = -1; setCmd(''); }
              else { histIdx.current = next; setCmd(histRef.current[next]); }
            }
          }} />
      </div>
    </>
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

export function TasksPanel({ fleet, finished, onClear }: {
  fleet: Array<{ kind: string; id: string; label: string }>;
  finished: FinishedTask[];
  onClear: () => void;
}): React.ReactElement {
  return (
    <div className="scroll">
      <div className="tasks-section"><span>Running</span></div>
      {fleet.length === 0 ? <div className="empty">Nothing running.</div> : fleet.map((f) => (
        <div key={f.id} className="task-row"><span className="task-kind">{f.kind}</span><span className="file-name">{f.label}</span></div>
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
  plan: { items: Array<{ step: string; status: string }>; explanation?: string } | null;
}): React.ReactElement {
  if (!plan || plan.items.length === 0) {
    return <div className="empty center-empty">☰<br />No plan yet<br /><span className="dim">The agent writes its plan here as it works.</span></div>;
  }
  return (
    <div className="scroll">
      {plan.explanation ? <div className="plan-why">{plan.explanation}</div> : null}
      {plan.items.map((it, i) => (
        <div key={i} className={`plan-item ${it.status}`}>
          <span className="plan-mark">{it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '◐' : '○'}</span>{it.step}
        </div>
      ))}
    </div>
  );
}
