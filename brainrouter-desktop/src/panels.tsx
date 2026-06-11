/**
 * DESK-4c — the panel system: togglable, closeable panels that open as
 * full-height resizable window columns right of the chat (File · Files ·
 * Diff · Terminal · Tool calls · Background tasks · Plan · Context ·
 * Search). Each panel is a dumb component over App-owned state; the App
 * owns column widths and the drag-to-resize grips.
 */
import React, { useMemo, useState } from 'react';

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
  return (
    <div className="picker">
      <button className="chip" onClick={() => setMenu((m) => !m)} title="Panels">⊞ Panels</button>
      {menu ? (
        <>
          <div className="picker-backdrop" onClick={() => setMenu(false)} />
          <div className="picker-menu">
            {PANEL_DEFS.map((d) => (
              <button key={d.id} className="picker-item" onClick={() => onToggle(d.id)}>
                <span className="picker-check">{open.includes(d.id) ? '✓' : ''}</span>
                <span className="picker-icon">{d.icon}</span>{d.title}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function FilesPanel({ files, statuses, onOpen }: {
  files: string[];
  statuses: Map<string, string>;
  onOpen: (path: string) => void;
}): React.ReactElement {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
    return list.slice(0, 400);
  }, [files, filter]);
  return (
    <>
      <input className="filter" placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="scroll">
        {shown.map((f) => (
          <div key={f} className="file-row" onClick={() => onOpen(f)} title={f}>
            <span className={`fstat ${statuses.has(f) ? 's-' + (statuses.get(f) ?? '').replace('?', 'u') : ''}`}>{statuses.get(f) ?? ''}</span>
            <span className="file-name">{f}</span>
          </div>
        ))}
        {shown.length === 0 ? <div className="empty">No matches.</div> : null}
      </div>
    </>
  );
}

export function FileViewerPanel({ view }: {
  view: { path: string; content: string; error?: string } | null;
}): React.ReactElement {
  if (!view) return <div className="empty">Open a file from the Files panel or a diff.</div>;
  if (view.error) return <div className="empty">✗ {view.error}</div>;
  const lines = view.content.split('\n');
  return (
    <>
      <div className="pathbar" title={view.path}>{view.path}</div>
      <div className="scroll code">
        {lines.map((l, i) => (
          <div key={i} className="code-line"><span className="ln">{i + 1}</span><span className="lc">{l || ' '}</span></div>
        ))}
      </div>
    </>
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
            <pre className="diff">{diff.diff.split('\n').map((line, i) => (
              <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>{line || ' '}</div>
            ))}</pre>
          </div>
        </>
      ) : (
        <div className="scroll">
          {changed.length === 0 ? <div className="empty">Working tree clean.</div> : changed.map((f) => (
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

export function TerminalPanel({ lines }: { lines: string[] }): React.ReactElement {
  return <pre className="term scroll">{lines.length ? lines.join('\n') : 'Shell output from run_command / background tasks appears here.'}</pre>;
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

export function TasksPanel({ fleet }: { fleet: Array<{ kind: string; id: string; label: string }> }): React.ReactElement {
  return (
    <div className="scroll">
      {fleet.length === 0 ? <div className="empty">No background tasks running.</div> : fleet.map((f) => (
        <div key={f.id} className="task-row"><span className="task-kind">{f.kind}</span><span className="file-name">{f.label}</span></div>
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
