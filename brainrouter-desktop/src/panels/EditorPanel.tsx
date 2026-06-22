/**
 * T5 — the in-app code editor. Monaco with editable tabs, dirty indicators,
 * Save / Save All / Revert, and read-only previews for binary/oversized files.
 * All writes go through the host action:file-save (never the renderer fs); this
 * component is pure UI over the useEditor hook in App.
 *
 * Lazy-loaded (React.lazy in App) so Monaco's ~5MB only loads when the editor
 * first opens — it must not inflate first paint.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import EditorComp, { type OnMount } from '@monaco-editor/react';
import { Icon } from '../icons.js';

// Same @types/react clash as react-markdown/react-syntax-highlighter — the
// runtime component is fine; cast to the props we actually pass.
type MonacoEditorProps = {
  path?: string; language?: string; value?: string; theme?: string;
  onMount?: OnMount; onChange?: (value: string | undefined) => void;
  loading?: React.ReactNode; options?: Record<string, unknown>;
  height?: string; width?: string;
};
const Editor = EditorComp as unknown as React.ComponentType<MonacoEditorProps>;
import { installMonaco, editorTheme, editorFontFamily } from '../lib/editor/monacoEnv.js';
import { isDirty, type EditorTab } from '../lib/editor/editorModel.js';
import {
  editorBasename,
  editorBreadcrumbs,
  editorStatusItems,
  parseEditorViewPrefs,
  serializeEditorPref,
  type EditorCursor,
} from '../lib/editor/editorView.js';

installMonaco();

type EditorPaneId = 'primary' | 'secondary';

function fmtBytes(n?: number): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function setQuietDragImage(e: React.DragEvent<HTMLElement>): void {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  e.dataTransfer.setDragImage(canvas, 0, 0);
}

export function EditorPanel({ tabs, activePath, conflictPaths, saving, onSelect, onChange, onSave, onSaveAll, onRevert, onClose, onReorder, onAnnotateSelection }: {
  tabs: EditorTab[];
  activePath: string | null;
  conflictPaths?: string[];
  saving?: boolean;
  onSelect: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  onSaveAll: () => void;
  onRevert: (path: string) => void;
  onClose: (path: string) => void;
  onReorder?: (draggedPath: string, targetPath: string) => void;
  onAnnotateSelection?: (path: string, body: string, anchor: { startLine: number; endLine: number; selectedText: string }) => void;
}): React.ReactElement {
  const active = tabs.find((t) => t.path === activePath) ?? null;
  const [secondaryPath, setSecondaryPath] = useState<string | null>(null);
  const secondary = secondaryPath ? tabs.find((t) => t.path === secondaryPath) ?? null : null;
  const [focusedPane, setFocusedPane] = useState<EditorPaneId>('primary');
  const [cursor, setCursor] = useState<EditorCursor>({ line: 1, column: 1 });
  const [wordWrap, setWordWrap] = useState(() => parseEditorViewPrefs(localStorage.getItem('br-editor-wrap'), localStorage.getItem('br-editor-minimap')).wordWrap);
  const [minimap, setMinimap] = useState(() => parseEditorViewPrefs(localStorage.getItem('br-editor-wrap'), localStorage.getItem('br-editor-minimap')).minimap);
  const [hasSelection, setHasSelection] = useState<Record<EditorPaneId, boolean>>({ primary: false, secondary: false });
  // keep the latest save handler reachable from Monaco's once-registered command
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const editorRefs = useRef<Record<EditorPaneId, Parameters<OnMount>[0] | null>>({ primary: null, secondary: null });
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [dropTab, setDropTab] = useState<string | null>(null);
  const lastDropTab = useRef<string | null>(null);

  useEffect(() => {
    localStorage.setItem('br-editor-wrap', serializeEditorPref(wordWrap));
  }, [wordWrap]);

  useEffect(() => {
    localStorage.setItem('br-editor-minimap', serializeEditorPref(minimap));
  }, [minimap]);

  useEffect(() => {
    setCursor({ line: 1, column: 1 });
    setHasSelection({ primary: false, secondary: false });
    setFocusedPane('primary');
  }, [activePath]);

  useEffect(() => {
    if (secondaryPath && !tabs.some((t) => t.path === secondaryPath)) setSecondaryPath(null);
  }, [secondaryPath, tabs]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      editorRefs.current.primary?.layout();
      editorRefs.current.secondary?.layout();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activePath, secondaryPath, tabs.length, wordWrap, minimap]);

  const focusedTab = focusedPane === 'secondary' && secondary ? secondary : active;
  const breadcrumbs = useMemo(() => focusedTab ? editorBreadcrumbs(focusedTab.path) : [], [focusedTab]);
  const statusItems = useMemo(() => focusedTab ? editorStatusItems(focusedTab, cursor) : [], [focusedTab, cursor]);

  const mountPane = (pane: EditorPaneId, path: string): OnMount => (editor, monaco) => {
    editorRefs.current[pane] = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current(path);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
      void editor.getAction('actions.find')?.run();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO, () => {
      void editor.getAction('editor.action.quickOutline')?.run();
    });
    const pos = editor.getPosition();
    if (pos) setCursor({ line: pos.lineNumber, column: pos.column });
    editor.onDidFocusEditorText(() => {
      setFocusedPane(pane);
      const current = editor.getPosition();
      if (current) setCursor({ line: current.lineNumber, column: current.column });
    });
    editor.onDidChangeCursorPosition((e) => {
      setFocusedPane(pane);
      setCursor({ line: e.position.lineNumber, column: e.position.column });
    });
    editor.onDidChangeCursorSelection(() => {
      const selection = editor.getSelection();
      setHasSelection((s) => ({ ...s, [pane]: !!selection && !selection.isEmpty() }));
    });
  };

  const runEditorAction = (id: string): void => {
    const ed = editorRefs.current[focusedPane] ?? editorRefs.current.primary;
    if (!ed) return;
    ed.focus();
    void ed.getAction(id)?.run();
  };

  const dirtyCount = tabs.filter(isDirty).length;
  const conflict = !!(active && conflictPaths?.includes(active.path));
  const focusedConflict = !!(focusedTab && conflictPaths?.includes(focusedTab.path));
  const canSplit = !!active && !active.binary;
  const annotateSelection = (): void => {
    const pane = focusedPane === 'secondary' && secondary ? 'secondary' : 'primary';
    const ed = editorRefs.current[pane];
    const model = ed?.getModel();
    const selection = ed?.getSelection();
    const tab = pane === 'secondary' ? secondary : active;
    if (!tab || !ed || !model || !selection || selection.isEmpty() || !onAnnotateSelection) return;
    const selectedText = model.getValueInRange(selection);
    const body = window.prompt('Annotation for selected code');
    if (!body?.trim()) return;
    onAnnotateSelection(tab.path, body.trim(), {
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
      selectedText,
    });
  };

  const selectTab = (path: string): void => {
    if (secondary && path === activePath) {
      setFocusedPane('primary');
      return;
    }
    if (secondary && path === secondaryPath) {
      setFocusedPane('secondary');
      return;
    }
    if (secondary && focusedPane === 'secondary') {
      setSecondaryPath(path);
      setFocusedPane('secondary');
      return;
    }
    onSelect(path);
    setFocusedPane('primary');
  };

  const clearTabDrag = (): void => {
    setDraggedTab(null);
    setDropTab(null);
    lastDropTab.current = null;
  };

  const reorderDraggedTab = (targetPath: string): void => {
    if (!onReorder || !draggedTab || draggedTab === targetPath || lastDropTab.current === targetPath) return;
    lastDropTab.current = targetPath;
    setDropTab(targetPath);
    onReorder(draggedTab, targetPath);
  };

  const renderPane = (pane: EditorPaneId, tab: EditorTab): React.ReactElement => {
    const paneFocused = focusedPane === pane;
    return (
      <div className={`editor-pane ${pane}${paneFocused ? ' focused' : ''}`} onPointerDown={() => setFocusedPane(pane)}>
        {secondary ? (
          <div className="editor-pane-head">
            <span title={tab.path}>{editorBasename(tab.path)}</span>
            {pane === 'secondary' ? (
              <button className="tab-close-btn editor-pane-close" title="Close split" aria-label="Close split" onClick={() => { setSecondaryPath(null); setFocusedPane('primary'); }}>
                <Icon name="close" size={10} />
              </button>
            ) : null}
          </div>
        ) : null}
        {tab.binary ? (
          <div className="empty center-empty editor-preview-card">
            <Icon name="file" size={20} />
            <div>Binary file — {fmtBytes(tab.size)}</div>
            <span className="dim">Preview unavailable. Open it in an external editor.</span>
          </div>
        ) : (
          <>
            {tab.truncated ? <div className="editor-banner">Read-only — file truncated at 200 KB.</div> : null}
            <Editor
              key={`${pane}:${tab.path}`}
              path={tab.path}
              language={tab.language}
              value={tab.content}
              theme={editorTheme()}
              height="100%"
              width="100%"
              onMount={mountPane(pane, tab.path)}
              onChange={(v) => onChange(tab.path, v ?? '')}
              loading={<div className="row status"><span className="spinner" /> Loading editor…</div>}
              options={{
                readOnly: tab.readOnly,
                fontFamily: editorFontFamily(),
                fontSize: 12.5,
                minimap: { enabled: minimap },
                wordWrap: wordWrap ? 'on' : 'off',
                scrollBeyondLastLine: false,
                renderLineHighlight: 'line',
                renderWhitespace: 'selection',
                stickyScroll: { enabled: true },
                bracketPairColorization: { enabled: true },
                overviewRulerLanes: 0,
                smoothScrolling: true,
                tabSize: 2,
                automaticLayout: true,
                padding: { top: 8, bottom: 8 },
                scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
              }}
            />
          </>
        )}
      </div>
    );
  };

  return (
    <div className="editor-panel">
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

      {conflict || focusedConflict ? (
        <div className="editor-conflict">This file changed on disk since you opened it. Save was blocked. Reopen it to get the latest, or Save again to confirm overwrite.</div>
      ) : null}

      {focusedTab ? (
        <div className="editor-breadcrumbs" title={focusedTab.path}>
          {breadcrumbs.map((part, idx) => (
            <React.Fragment key={`${part}-${idx}`}>
              {idx > 0 ? <Icon name="chev-right" size={10} /> : null}
              <span className={idx === breadcrumbs.length - 1 ? 'current' : ''}>{part}</span>
            </React.Fragment>
          ))}
        </div>
      ) : null}

      <div className="editor-body">
        {!active ? (
          <div className="empty center-empty">Open a file from the Files panel or a diff to edit it here.</div>
        ) : (
          <div className={`editor-split${secondary ? ' two' : ' one'}`}>
            {renderPane('primary', active)}
            {secondary ? renderPane('secondary', secondary) : null}
          </div>
        )}
      </div>

      {focusedTab && !focusedTab.binary ? (
        <div className="editor-status">
          <span className="editor-status-path" title={focusedTab.path}>{focusedTab.path}</span>
          {statusItems.map((item) => <span key={item} className="editor-status-item">{item}</span>)}
          {isDirty(focusedTab) ? <span className="editor-status-dirty">● unsaved</span> : <span className="editor-status-clean">saved</span>}
        </div>
      ) : null}
    </div>
  );
}
