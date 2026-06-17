/**
 * DESK-5c — the Files panel: a VS Code-style folder tree built from the flat
 * git file list, with a filter box that flips into a `?text` content-search.
 */
import React, { useMemo, useState } from 'react';
import { Icon } from '../icons.js';

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
