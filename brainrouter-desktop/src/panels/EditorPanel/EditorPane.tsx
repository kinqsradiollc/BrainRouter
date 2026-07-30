/**
 * EditorPane — one Monaco pane (primary or secondary split) plus its chrome: the
 * split header/close, the binary-file preview card, and the truncated-file banner.
 * Extracted from EditorPanel's `renderPane` closure; the render tree is identical,
 * with the closure's captured values now passed as props.
 */
import React from 'react';
import EditorComp, { type OnMount } from '@monaco-editor/react';
import { Icon } from '../../icons.js';
import { editorTheme } from '../../lib/editor/monacoEnv.js';
import { type EditorTab } from '../../lib/editor/editorModel.js';
import { editorBasename } from '../../lib/editor/editorView.js';
import { fmtBytes, type EditorPaneId } from './editorPaneHelpers.js';
import { monacoOptions } from './monacoOptions.js';

// Same @types/react clash as react-markdown/react-syntax-highlighter — the
// runtime component is fine; cast to the props we actually pass.
type MonacoEditorProps = {
  path?: string; language?: string; value?: string; theme?: string;
  onMount?: OnMount; onChange?: (value: string | undefined) => void;
  loading?: React.ReactNode; options?: Record<string, unknown>;
  height?: string; width?: string;
};
const Editor = EditorComp as unknown as React.ComponentType<MonacoEditorProps>;

export function EditorPane({ pane, tab, focusedPane, hasSecondary, minimap, wordWrap, setFocusedPane, closeSplit, mountPane, onChange }: {
  pane: EditorPaneId;
  tab: EditorTab;
  focusedPane: EditorPaneId;
  hasSecondary: boolean;
  minimap: boolean;
  wordWrap: boolean;
  setFocusedPane: (pane: EditorPaneId) => void;
  closeSplit: () => void;
  mountPane: (pane: EditorPaneId, path: string) => OnMount;
  onChange: (path: string, content: string) => void;
}): React.ReactElement {
  const paneFocused = focusedPane === pane;
  return (
    <div className={`editor-pane ${pane}${paneFocused ? ' focused' : ''}`} onPointerDown={() => setFocusedPane(pane)}>
      {hasSecondary ? (
        <div className="editor-pane-head">
          <span title={tab.path}>{editorBasename(tab.path)}</span>
          {pane === 'secondary' ? (
            <button className="tab-close-btn editor-pane-close" title="Close split" aria-label="Close split" onClick={closeSplit}>
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
            options={monacoOptions(tab, minimap, wordWrap)}
          />
        </>
      )}
    </div>
  );
}
