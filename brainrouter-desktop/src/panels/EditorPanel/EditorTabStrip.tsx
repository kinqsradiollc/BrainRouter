/**
 * EditorTabStrip — the top tab row (drag-to-reorder, dirty dots, split marker)
 * and the right-hand actions cluster (find / go-to-symbol / annotate / split /
 * wrap / minimap / Save / Save all / Revert). Lifted out of EditorPanel's render;
 * the JSX and every handler are identical, with the panel's closures passed in.
 */
import React from 'react';
import { Icon } from '../../icons.js';
import { isDirty, type EditorTab } from '../../lib/editor/editorModel.js';
import { editorBasename } from '../../lib/editor/editorView.js';
import { setQuietDragImage, type EditorPaneId } from './editorPaneHelpers.js';

export function EditorTabStrip({
  tabs, activePath, secondaryPath, focusedPane, draggedTab, dropTab,
  active, secondary, focusedTab, hasSelection, canSplit, wordWrap, minimap,
  dirtyCount, saving, onReorder, onAnnotateSelection,
  setDraggedTab, setDropTab, lastDropTab, setSecondaryPath, setFocusedPane, setWordWrap, setMinimap,
  onClose, onSave, onSaveAll, onRevert,
  selectTab, clearTabDrag, reorderDraggedTab, runEditorAction, annotateSelection,
}: {
  tabs: EditorTab[];
  activePath: string | null;
  secondaryPath: string | null;
  focusedPane: EditorPaneId;
  draggedTab: string | null;
  dropTab: string | null;
  active: EditorTab | null;
  secondary: EditorTab | null;
  focusedTab: EditorTab | null;
  hasSelection: Record<EditorPaneId, boolean>;
  canSplit: boolean;
  wordWrap: boolean;
  minimap: boolean;
  dirtyCount: number;
  saving?: boolean;
  onReorder?: (draggedPath: string, targetPath: string) => void;
  onAnnotateSelection?: (path: string, body: string, anchor: { startLine: number; endLine: number; selectedText: string }) => void;
  setDraggedTab: React.Dispatch<React.SetStateAction<string | null>>;
  setDropTab: React.Dispatch<React.SetStateAction<string | null>>;
  lastDropTab: React.MutableRefObject<string | null>;
  setSecondaryPath: React.Dispatch<React.SetStateAction<string | null>>;
  setFocusedPane: React.Dispatch<React.SetStateAction<EditorPaneId>>;
  setWordWrap: React.Dispatch<React.SetStateAction<boolean>>;
  setMinimap: React.Dispatch<React.SetStateAction<boolean>>;
  onClose: (path: string) => void;
  onSave: (path: string) => void;
  onSaveAll: () => void;
  onRevert: (path: string) => void;
  selectTab: (path: string) => void;
  clearTabDrag: () => void;
  reorderDraggedTab: (targetPath: string) => void;
  runEditorAction: (id: string) => void;
  annotateSelection: () => void;
}): React.ReactElement {
  return (
    <div className="editor-tabs">
      <div className="editor-tabs-list">
        {tabs.length === 0 ? <div className="editor-tab-empty">No open files</div> : tabs.map((t) => {
          const name = editorBasename(t.path);
          const dirty = isDirty(t);
          const isPrimary = t.path === activePath;
          const isSecondary = t.path === secondaryPath;
          const isFocused = focusedPane === 'secondary' ? isSecondary : isPrimary;
          return (
            <div key={t.path} className={`editor-tab${isPrimary ? ' active' : ''}${isSecondary ? ' split' : ''}${isFocused ? ' focused' : ''}${draggedTab === t.path ? ' dragging' : ''}${dropTab === t.path ? ' drop-target' : ''}`} title={t.path}
              draggable={!!onReorder}
              onDragStart={(e) => {
                setDraggedTab(t.path);
                setDropTab(null);
                lastDropTab.current = null;
                e.dataTransfer.setData('application/x-br-editor-tab', t.path);
                e.dataTransfer.effectAllowed = 'move';
                setQuietDragImage(e);
              }}
              onDragEnter={(e) => { if (onReorder) { e.preventDefault(); reorderDraggedTab(t.path); } }}
              onDragOver={(e) => { if (onReorder) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
              onDrop={(e) => {
                if (!onReorder) return;
                e.preventDefault();
                const dragged = draggedTab ?? e.dataTransfer.getData('application/x-br-editor-tab');
                if (dragged && dragged !== t.path && lastDropTab.current !== t.path) onReorder(dragged, t.path);
                clearTabDrag();
              }}
              onDragEnd={clearTabDrag}
              onClick={() => selectTab(t.path)}>
              <span className="editor-tab-name">{name}</span>
              <button className="tab-close-btn editor-tab-x" title={dirty ? 'Unsaved — close anyway' : 'Close'} aria-label={`Close ${name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (t.path === secondaryPath) setSecondaryPath(null);
                  onClose(t.path);
                }}>
                {dirty ? <span className="editor-dirty-dot" /> : <Icon name="close" size={10} />}
              </button>
            </div>
          );
        })}
      </div>
      <div className="editor-actions">
        <button className="editor-icon-act" disabled={!active || active.binary} title="Find in file (⌘F)" aria-label="Find in file" onClick={() => runEditorAction('actions.find')}><Icon name="search" size={12} /></button>
        <button className="editor-icon-act" disabled={!active || active.binary} title="Go to symbol (⌘⇧O)" aria-label="Go to symbol" onClick={() => runEditorAction('editor.action.quickOutline')}><Icon name="code" size={12} /></button>
        <button className="editor-icon-act" disabled={!focusedTab || focusedTab.binary || !hasSelection[focusedPane] || !onAnnotateSelection} title="Annotate selected code" aria-label="Annotate selected code" onClick={annotateSelection}><Icon name="bubble" size={12} /></button>
        <button className={`editor-icon-act${secondary ? ' active' : ''}`} disabled={!canSplit} title={secondary ? 'Close split editor' : 'Split editor right'} aria-label={secondary ? 'Close split editor' : 'Split editor right'}
          onClick={() => {
            if (secondary) { setSecondaryPath(null); setFocusedPane('primary'); }
            else if (active) {
              const splitTarget = tabs.find((t) => t.path !== active.path && !t.binary) ?? active;
              setSecondaryPath(splitTarget.path);
              setFocusedPane('secondary');
            }
          }}><Icon name="layout-right" size={12} /></button>
        <button className={`editor-icon-act${wordWrap ? ' active' : ''}`} disabled={!active || active.binary} title="Toggle word wrap" aria-label="Toggle word wrap" onClick={() => setWordWrap((v) => !v)}>Wrap</button>
        <button className={`editor-icon-act${minimap ? ' active' : ''}`} disabled={!active || active.binary} title="Toggle minimap" aria-label="Toggle minimap" onClick={() => setMinimap((v) => !v)}>Map</button>
        <button className="editor-act" disabled={!focusedTab || !isDirty(focusedTab) || saving} title="Save (⌘S)" onClick={() => focusedTab && onSave(focusedTab.path)}>Save</button>
        <button className="editor-act" disabled={dirtyCount === 0 || saving} title="Save all unsaved files" onClick={onSaveAll}>Save all{dirtyCount ? ` (${dirtyCount})` : ''}</button>
        <button className="editor-act" disabled={!focusedTab || !isDirty(focusedTab)} title="Discard changes" onClick={() => focusedTab && onRevert(focusedTab.path)}>Revert</button>
      </div>
    </div>
  );
}
