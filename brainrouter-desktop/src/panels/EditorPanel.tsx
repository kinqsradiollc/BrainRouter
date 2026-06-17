/**
 * T5 — the in-app code editor. Monaco with editable tabs, dirty indicators,
 * Save / Save All / Revert, and read-only previews for binary/oversized files.
 * All writes go through the host action:file-save (never the renderer fs); this
 * component is pure UI over the useEditor hook in App.
 *
 * Lazy-loaded (React.lazy in App) so Monaco's ~5MB only loads when the editor
 * first opens — it must not inflate first paint.
 */
import React, { useRef } from 'react';
import EditorComp, { type OnMount } from '@monaco-editor/react';
import { Icon } from '../icons.js';

// Same @types/react clash as react-markdown/react-syntax-highlighter — the
// runtime component is fine; cast to the props we actually pass.
type MonacoEditorProps = {
  path?: string; language?: string; value?: string; theme?: string;
  onMount?: OnMount; onChange?: (value: string | undefined) => void;
  loading?: React.ReactNode; options?: Record<string, unknown>;
};
const Editor = EditorComp as unknown as React.ComponentType<MonacoEditorProps>;
import { installMonaco, editorTheme, editorFontFamily } from '../lib/editor/monacoEnv.js';
import { isDirty, type EditorTab } from '../lib/editor/editorModel.js';

installMonaco();

function fmtBytes(n?: number): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function EditorPanel({ tabs, activePath, conflictPaths, saving, onSelect, onChange, onSave, onSaveAll, onRevert, onClose }: {
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
}): React.ReactElement {
  const active = tabs.find((t) => t.path === activePath) ?? null;
  // keep the latest save handler reachable from Monaco's once-registered command
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activeRef.current) saveRef.current(activeRef.current);
    });
  };

  const dirtyCount = tabs.filter(isDirty).length;
  const conflict = active && conflictPaths?.includes(active.path);

  return (
    <div className="editor-panel">
      <div className="editor-tabs">
        {tabs.length === 0 ? <div className="editor-tab-empty">No open files</div> : tabs.map((t) => {
          const name = t.path.split('/').pop() || t.path;
          const dirty = isDirty(t);
          return (
            <div key={t.path} className={`editor-tab${t.path === activePath ? ' active' : ''}`} title={t.path} onClick={() => onSelect(t.path)}>
              <span className="editor-tab-name">{name}</span>
              <button className="editor-tab-x" title={dirty ? 'Unsaved — close anyway' : 'Close'} onClick={(e) => { e.stopPropagation(); onClose(t.path); }}>
                {dirty ? <span className="editor-dirty-dot" /> : <Icon name="close" size={10} />}
              </button>
            </div>
          );
        })}
        <span className="editor-tabs-spacer" />
        <button className="editor-act" disabled={!active || !isDirty(active) || saving} title="Save (⌘S)" onClick={() => active && onSave(active.path)}>Save</button>
        <button className="editor-act" disabled={dirtyCount === 0 || saving} title="Save all unsaved files" onClick={onSaveAll}>Save all{dirtyCount ? ` (${dirtyCount})` : ''}</button>
        <button className="editor-act" disabled={!active || !isDirty(active)} title="Discard changes" onClick={() => active && onRevert(active.path)}>Revert</button>
      </div>

      {conflict ? (
        <div className="editor-conflict">⚠ This file changed on disk since you opened it — Save was blocked. Reopen it to get the latest, or Save again to confirm overwrite.</div>
      ) : null}

      <div className="editor-body">
        {!active ? (
          <div className="empty center-empty">Open a file from the Files panel or a diff to edit it here.</div>
        ) : active.binary ? (
          <div className="empty center-empty editor-preview-card">
            <Icon name="file" size={20} />
            <div>Binary file — {fmtBytes(active.size)}</div>
            <span className="dim">Preview unavailable. Open it in an external editor.</span>
          </div>
        ) : (
          <>
            {active.truncated ? <div className="editor-banner">Read-only — file truncated at 200 KB.</div> : null}
            <Editor
              key={active.path}
              path={active.path}
              language={active.language}
              value={active.content}
              theme={editorTheme()}
              onMount={onMount}
              onChange={(v) => onChange(active.path, v ?? '')}
              loading={<div className="row status"><span className="spinner" /> Loading editor…</div>}
              options={{
                readOnly: active.readOnly,
                fontFamily: editorFontFamily(),
                fontSize: 12.5,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderLineHighlight: 'line',
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

      {active && !active.binary ? (
        <div className="editor-status">
          <span className="editor-status-path" title={active.path}>{active.path}</span>
          <span className="editor-status-lang">{active.language}</span>
          {isDirty(active) ? <span className="editor-status-dirty">● unsaved</span> : <span className="editor-status-clean">saved</span>}
        </div>
      ) : null}
    </div>
  );
}
