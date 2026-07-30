import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../icons.js';
import {
  buildFileTree,
  calculateVirtualRowWindow,
  FILE_TREE_ROW_HEIGHT,
  flattenVisibleFileTree,
  type FileTreeRow,
} from './fileExplorerModel.js';

export { buildFileTree } from './fileExplorerModel.js';

function useViewportWindow(rowCount: number): {
  viewportRef: React.RefObject<HTMLDivElement>;
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
  virtualized: boolean;
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
} {
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = (): void => setViewportHeight(Math.max(FILE_TREE_ROW_HEIGHT, viewport.clientHeight));
    updateSize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateSize);
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const onScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    const nextTop = event.currentTarget.scrollTop;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setScrollTop(nextTop);
    });
  };

  return {
    viewportRef,
    ...calculateVirtualRowWindow(rowCount, scrollTop, viewportHeight),
    onScroll,
  };
}

function TreeRow({ row, selectedPath, onToggle, onOpen, statuses, virtualizedOffset }: {
  row: FileTreeRow;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  statuses: ReadonlyMap<string, string>;
  virtualizedOffset?: number;
}): React.ReactElement {
  const selected = row.kind === 'file' && selectedPath === row.path;
  const virtualized = virtualizedOffset !== undefined;
  const position = virtualized
    ? { height: FILE_TREE_ROW_HEIGHT, left: 0, right: 0, top: virtualizedOffset }
    : undefined;
  if (row.kind === 'directory') {
    return (
      <div
        className={`tree-row${virtualized ? ' file-explorer-virtual-row' : ''}`}
        role="treeitem"
        aria-expanded={row.expanded}
        aria-level={row.depth + 1}
        style={{ ...position, paddingLeft: 8 + row.depth * 14 }}
        onClick={() => onToggle(row.path)}
      >
        <span className="tree-chevron"><Icon name={row.expanded ? 'chev-down' : 'chev-right'} size={10} /></span>
        <span className="tree-folder"><Icon name={row.expanded ? 'folder-open' : 'folder'} size={13} /></span>
        <span className="file-name">{row.name}</span>
      </div>
    );
  }
  return (
    <div
      className={`tree-row file${selected ? ' selected' : ''}${virtualized ? ' file-explorer-virtual-row' : ''}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      style={{ ...position, paddingLeft: 8 + row.depth * 14 + 14 }}
      onClick={() => onOpen(row.path)}
      title={row.path}
    >
      <span className="file-name">{row.name}</span>
      {statuses.has(row.path) ? <span className={`fstat s-${(statuses.get(row.path) ?? '').replace('?', 'u')}`}>{statuses.get(row.path)}</span> : null}
    </div>
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
  const treeRows = useMemo(() => flattenVisibleFileTree(tree, expanded), [tree, expanded]);
  const shown = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const matches = query ? files.filter((file) => file.toLowerCase().includes(query)) : files;
    return matches.slice(0, 400);
  }, [files, filter]);
  const rows = filter.trim() ? shown.length : treeRows.length;
  const rowWindow = useViewportWindow(rows);
  const visibleTreeRows = treeRows.slice(rowWindow.start, rowWindow.end);
  const visibleFilteredFiles = shown.slice(rowWindow.start, rowWindow.end);

  if (!filter.trim()) {
    return (
      <div
        ref={rowWindow.viewportRef}
        className="file-explorer-viewport"
        role="tree"
        aria-label="Workspace files"
        data-virtualized={rowWindow.virtualized || undefined}
        onScroll={rowWindow.onScroll}
      >
        <div
          className="file-explorer-canvas"
          style={rowWindow.virtualized ? { height: rowWindow.totalHeight } : undefined}
        >
          {visibleTreeRows.map((row, index) => (
            <TreeRow
              key={row.path}
              row={row}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onOpen={onOpen}
              statuses={statuses}
              virtualizedOffset={rowWindow.virtualized
                ? rowWindow.offsetTop + index * FILE_TREE_ROW_HEIGHT
                : undefined}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rowWindow.viewportRef}
      className="file-explorer-viewport"
      role="listbox"
      aria-label="Filtered workspace files"
      data-virtualized={rowWindow.virtualized || undefined}
      onScroll={rowWindow.onScroll}
    >
      <div
        className="file-explorer-canvas"
        style={rowWindow.virtualized ? { height: rowWindow.totalHeight } : undefined}
      >
        {visibleFilteredFiles.map((file, index) => {
          const selected = selectedPath === file;
          return (
            <div
              key={file}
              className={`file-row${selected ? ' selected' : ''}${rowWindow.virtualized ? ' file-explorer-virtual-row' : ''}`}
              role="option"
              aria-selected={selected}
              onClick={() => onOpen(file)}
              title={file}
              style={rowWindow.virtualized ? {
                height: FILE_TREE_ROW_HEIGHT,
                left: 0,
                right: 0,
                top: rowWindow.offsetTop + index * FILE_TREE_ROW_HEIGHT,
              } : undefined}
            >
              <span className={`fstat ${statuses.has(file) ? `s-${(statuses.get(file) ?? '').replace('?', 'u')}` : ''}`}>{statuses.get(file) ?? ''}</span>
              <span className="file-name">{file}</span>
            </div>
          );
        })}
        {shown.length === 0 ? <div className="empty">No matches.</div> : null}
      </div>
    </div>
  );
}
