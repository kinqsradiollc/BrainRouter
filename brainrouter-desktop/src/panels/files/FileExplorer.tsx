import React, { useMemo } from 'react';
import { Icon } from '../../icons.js';

interface TreeDir { dirs: Map<string, TreeDir>; files: string[] }

export function buildFileTree(paths: readonly string[]): TreeDir {
  const root: TreeDir = { dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      let next = node.dirs.get(parts[index]);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(parts[index], next);
      }
      node = next;
    }
    node.files.push(parts[parts.length - 1]);
  }
  return root;
}

function TreeLevel({ dir, base, depth, expanded, selectedPath, onToggle, onOpen, statuses }: {
  dir: TreeDir;
  base: string;
  depth: number;
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  statuses: ReadonlyMap<string, string>;
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
            <div className="tree-row" role="treeitem" aria-expanded={open} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onToggle(full)}>
              <span className="tree-chevron"><Icon name={open ? 'chev-down' : 'chev-right'} size={10} /></span>
              <span className="tree-folder"><Icon name={open ? 'folder-open' : 'folder'} size={13} /></span>
              <span className="file-name">{name}</span>
            </div>
            {open ? (
              <TreeLevel
                dir={dir.dirs.get(name)!}
                base={full}
                depth={depth + 1}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onOpen={onOpen}
                statuses={statuses}
              />
            ) : null}
          </React.Fragment>
        );
      })}
      {fileNames.map((name) => {
        const full = base ? `${base}/${name}` : name;
        const selected = selectedPath === full;
        return (
          <div
            key={full}
            className={`tree-row file${selected ? ' selected' : ''}`}
            role="treeitem"
            aria-selected={selected}
            style={{ paddingLeft: 8 + depth * 14 + 14 }}
            onClick={() => onOpen(full)}
            title={full}
          >
            <span className="file-name">{name}</span>
            {statuses.has(full) ? <span className={`fstat s-${(statuses.get(full) ?? '').replace('?', 'u')}`}>{statuses.get(full)}</span> : null}
          </div>
        );
      })}
    </>
  );
}

export function FileExplorer({ files, statuses, filter, expandedPaths, selectedPath, onToggle, onOpen }: {
  files: readonly string[];
  statuses: ReadonlyMap<string, string>;
  filter: string;
  expandedPaths: readonly string[];
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}): React.ReactElement {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const shown = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const matches = query ? files.filter((file) => file.toLowerCase().includes(query)) : files;
    return matches.slice(0, 400);
  }, [files, filter]);

  if (!filter.trim()) {
    return (
      <div role="tree" aria-label="Workspace files">
        <TreeLevel
          dir={tree}
          base=""
          depth={0}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onOpen={onOpen}
          statuses={statuses}
        />
      </div>
    );
  }

  return (
    <div role="listbox" aria-label="Filtered workspace files">
      {shown.map((file) => {
        const selected = selectedPath === file;
        return (
          <div
            key={file}
            className={`file-row${selected ? ' selected' : ''}`}
            role="option"
            aria-selected={selected}
            onClick={() => onOpen(file)}
            title={file}
          >
            <span className={`fstat ${statuses.has(file) ? `s-${(statuses.get(file) ?? '').replace('?', 'u')}` : ''}`}>{statuses.get(file) ?? ''}</span>
            <span className="file-name">{file}</span>
          </div>
        );
      })}
      {shown.length === 0 ? <div className="empty">No matches.</div> : null}
    </div>
  );
}
