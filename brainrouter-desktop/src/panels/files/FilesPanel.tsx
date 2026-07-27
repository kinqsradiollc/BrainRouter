/**
 * DESK-5c — the Files panel: a VS Code-style folder tree built from the flat
 * git file list, with a filter box that flips into a `?text` content-search.
 */
import React from 'react';
import { Icon } from '../../icons.js';
import { FileExplorer } from './FileExplorer.js';
import { useFileExplorerState } from './fileExplorerState.js';

export interface GrepHit { file: string; line: number; snippet: string }
export { buildFileTree } from './FileExplorer.js';

export function FilesPanel({ workspaceKey, files, statuses, onOpen, grepHits, onGrep, onRefresh, loading = false, truncated = false, error = '' }: {
  workspaceKey: string;
  files: string[];
  statuses: Map<string, string>;
  onOpen: (path: string) => void;
  grepHits: GrepHit[] | null;
  onGrep: (q: string) => void;
  onRefresh: () => void;
  loading?: boolean;
  truncated?: boolean;
  error?: string;
}): React.ReactElement {
  const explorer = useFileExplorerState(workspaceKey, files, !loading);
  const { filter } = explorer.state;
  const contentMode = filter.startsWith('?');
  const openFile = (path: string): void => {
    explorer.select(path);
    onOpen(path);
  };
  return (
    <>
      <div className="files-toolbar">
        <input className="filter" placeholder="Filter files… (?text to search contents)" value={filter}
          onChange={(e) => explorer.setFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && contentMode && filter.slice(1).trim()) onGrep(filter.slice(1).trim()); }} />
        <button type="button" className="icon-btn files-refresh" title="Refresh files" aria-label="Refresh files" onClick={onRefresh} disabled={loading}>
          {loading ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
        </button>
      </div>
      {loading || truncated ? (
        <div className="panel-mini-status">
          {loading ? <span><span className="spinner" /> Loading files…</span> : null}
          {truncated ? <span>Showing the first {files.length.toLocaleString()} files.</span> : null}
        </div>
      ) : null}
      {error ? <div className="panel-mini-status warn"><span>{error}</span></div> : null}
      <div className="scroll">
        {contentMode ? (
          grepHits === null ? <div className="empty">Press Enter to search file contents.</div>
            : grepHits.length === 0 ? <div className="empty center-empty">No matches</div>
            : grepHits.map((h, i) => (
              <div key={i} className="grep-hit" onClick={() => openFile(h.file)}>
                <div className="grep-file">{h.file}:{h.line}</div>
                <div className="grep-snippet">{h.snippet}</div>
              </div>
            ))
        ) : files.length === 0 ? (
          <div className="empty center-empty">{loading ? 'Loading files…' : 'Folder is empty'}</div>
        ) : (
          <FileExplorer
            files={files}
            statuses={statuses}
            filter={filter}
            expandedPaths={explorer.state.expanded}
            selectedPath={explorer.state.selectedPath}
            onToggle={explorer.toggleExpanded}
            onOpen={openFile}
          />
        )}
      </div>
    </>
  );
}
