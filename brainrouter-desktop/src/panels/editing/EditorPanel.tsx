/**
 * T5 — the in-app code editor. Monaco with editable tabs, dirty indicators,
 * Save / Save All / Revert, and read-only previews for binary/oversized files.
 * All writes go through the host action:file-save (never the renderer fs); this
 * component is pure UI over the useEditor hook in App.
 *
 * Lazy-loaded (React.lazy in App) so Monaco's ~5MB only loads when the editor
 * first opens — it must not inflate first paint.
 *
 * The panel body is intentionally thin: the tab strip, the Monaco panes, and the
 * Markdown-mode handlers live in sibling modules under ./EditorPanel/. This file
 * owns the shared state/refs and wires the pieces together — same render, same
 * behaviour.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type OnMount } from '@monaco-editor/react';
import { Icon } from '../../icons.js';
import { installMonaco } from '../../lib/editor/monacoEnv.js';
import { isDirty, type EditorTab } from '../../lib/editor/editorModel.js';
import { MARKDOWN_FILE } from '../../lib/docs/markdownExport.js';
import {
  MarkdownPreview, WritingAssistant, ReviewOverlay,
  registerMarkdownGhost, setActiveMarkdownModel,
  ACTION_LABEL, type InlineAction,
} from '../editor/markdownMode.js';
import { BarMenu } from '../editor/BarMenu.js';
import {
  editorBreadcrumbs,
  editorStatusItems,
  parseEditorViewPrefs,
  serializeEditorPref,
  type EditorCursor,
} from '../../lib/editor/editorView.js';
import { type EditorPaneId } from '../EditorPanel/editorPaneHelpers.js';
import { EditorPane } from '../EditorPanel/EditorPane.js';
import { EditorTabStrip } from '../EditorPanel/EditorTabStrip.js';
import { useMarkdownMode } from '../EditorPanel/useMarkdownMode.js';

installMonaco();

export function EditorPanel({ tabs, activePath, conflictPaths, saving, revealLine, onSelect, onChange, onSave, onSaveAll, onRevert, onClose, onReorder, onAnnotateSelection, onOpenFile, onOpenUrl }: {
  tabs: EditorTab[];
  activePath: string | null;
  conflictPaths?: string[];
  saving?: boolean;
  /** Reveal+focus a line in the tab at `path` (e.g. Atlas symbol line-jump). */
  revealLine?: { path: string; line: number; seq: number } | null;
  onSelect: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  onSaveAll: () => void;
  onRevert: (path: string) => void;
  onClose: (path: string) => void;
  onReorder?: (draggedPath: string, targetPath: string) => void;
  onAnnotateSelection?: (path: string, body: string, anchor: { startLine: number; endLine: number; selectedText: string }) => void;
  /** Markdown-mode preview links: open a workspace file (code Editor) / external URL (browser). */
  onOpenFile?: (path: string) => void;
  onOpenUrl?: (url: string) => void;
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
  // Symbol line-jump: apply the latest reveal request once, whether the editor is
  // already mounted (effect below) or mounts after the file loads (mountPane).
  const revealLineRef = useRef(revealLine);
  revealLineRef.current = revealLine;
  const lastRevealSeq = useRef(0);
  const applyReveal = (ed: Parameters<OnMount>[0], line: number, seq: number): void => {
    lastRevealSeq.current = seq;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
  };
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [dropTab, setDropTab] = useState<string | null>(null);
  const lastDropTab = useRef<string | null>(null);

  // Markdown mode applies to a non-binary .md file in the primary pane (the code
  // split takes precedence, so two Monacos never fight a preview pane).
  const mdTab = active && !active.binary && !secondary && MARKDOWN_FILE.test(active.path) ? active : null;
  const mdEditor = (): Parameters<OnMount>[0] | null => editorRefs.current.primary;
  // ── Markdown mode (the folded-in Docs experience for .md/.markdown/.mdx).
  const {
    mdView, setMdView, review, setReview, mdStatus, setMdStatus, aiBusy,
    exportAs, copyRich, runInline, setDecision, setAllDecisions, applyReviewToDoc,
  } = useMarkdownMode(mdTab, mdEditor);

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
    setReview(null);
    setMdStatus('');
  }, [activePath]);

  useEffect(() => {
    if (secondaryPath && !tabs.some((t) => t.path === secondaryPath)) setSecondaryPath(null);
  }, [secondaryPath, tabs]);

  // Reveal the requested line in whichever pane holds the file (if its editor is
  // already mounted; otherwise mountPane applies it once Monaco is ready).
  useEffect(() => {
    if (!revealLine || revealLine.seq === lastRevealSeq.current) return;
    const pane: EditorPaneId | null = revealLine.path === activePath ? 'primary' : revealLine.path === secondaryPath ? 'secondary' : null;
    const ed = pane ? editorRefs.current[pane] : null;
    if (ed) applyReveal(ed, revealLine.line, revealLine.seq);
  }, [revealLine, activePath, secondaryPath, tabs.length]);

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
    // Markdown ghost-text (W4): register once; scope completions to the active
    // Markdown file in the primary pane so code files never ghost.
    registerMarkdownGhost(monaco);
    if (pane === 'primary' && MARKDOWN_FILE.test(path)) setActiveMarkdownModel(editor.getModel()?.uri.toString() ?? null);
    // A reveal queued before this editor mounted (newly-opened file) applies now.
    const pending = revealLineRef.current;
    if (pending && pending.path === path && pending.seq !== lastRevealSeq.current) {
      applyReveal(editor, pending.line, pending.seq);
    }
    // Cmd/Ctrl+S routes to the host save (not a Monaco built-in, so it must be
    // bound). Find (Cmd+F), Replace (Cmd+Alt+F), Go-to-symbol (Cmd+Shift+O),
    // multi-cursor, move/copy/delete-line, comment toggle, fold, rename, etc. are
    // all Monaco built-ins — no rebinding needed.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current(path);
    });
    // macOS alias: Cmd+G → Go to Line (Monaco's mac default is Ctrl+G; on mac
    // Cmd+G is find-next). Gives the familiar VS Code Windows-style key on mac too.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () => {
      void editor.getAction('editor.action.gotoLine')?.run();
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

  const renderPane = (pane: EditorPaneId, tab: EditorTab): React.ReactElement => (
    <EditorPane
      pane={pane}
      tab={tab}
      focusedPane={focusedPane}
      hasSecondary={!!secondary}
      minimap={minimap}
      wordWrap={wordWrap}
      setFocusedPane={setFocusedPane}
      closeSplit={() => { setSecondaryPath(null); setFocusedPane('primary'); }}
      mountPane={mountPane}
      onChange={onChange}
    />
  );

  return (
    <div className="editor-panel">
      <EditorTabStrip
        tabs={tabs}
        activePath={activePath}
        secondaryPath={secondaryPath}
        focusedPane={focusedPane}
        draggedTab={draggedTab}
        dropTab={dropTab}
        active={active}
        secondary={secondary}
        focusedTab={focusedTab}
        hasSelection={hasSelection}
        canSplit={canSplit}
        wordWrap={wordWrap}
        minimap={minimap}
        dirtyCount={dirtyCount}
        saving={saving}
        onReorder={onReorder}
        onAnnotateSelection={onAnnotateSelection}
        setDraggedTab={setDraggedTab}
        setDropTab={setDropTab}
        lastDropTab={lastDropTab}
        setSecondaryPath={setSecondaryPath}
        setFocusedPane={setFocusedPane}
        setWordWrap={setWordWrap}
        setMinimap={setMinimap}
        onClose={onClose}
        onSave={onSave}
        onSaveAll={onSaveAll}
        onRevert={onRevert}
        selectTab={selectTab}
        clearTabDrag={clearTabDrag}
        reorderDraggedTab={reorderDraggedTab}
        runEditorAction={runEditorAction}
        annotateSelection={annotateSelection}
      />

      {mdTab ? (
        <div className="editor-md-bar">
          <div className="docs-modes">
            {(['edit', 'split', 'preview'] as const).map((m) => (
              <button key={m} className={`docs-mode${mdView === m ? ' on' : ''}`} onClick={() => setMdView(m)}>{m}</button>
            ))}
          </div>
          {mdView !== 'preview' ? (
            <BarMenu
              label={aiBusy ? '✦ Working…' : '✦ Selection AI'}
              disabled={aiBusy}
              title={hasSelection.primary ? 'Rewrite the selected text' : 'Select text in the editor, then choose an action'}
              items={(['polish', 'rewrite', 'continue'] as InlineAction[]).map((act) => ({
                label: ACTION_LABEL[act],
                hint: act === 'polish' ? 'tighten & fix' : act === 'rewrite' ? 'reword' : 'extend',
                disabled: !hasSelection.primary,
                onSelect: () => void runInline(act),
              }))}
            />
          ) : null}
          <span className="editor-md-spacer" />
          {mdStatus ? <span className="editor-md-status">{mdStatus}</span> : null}
          <BarMenu
            label="Export"
            title="Export or copy the rendered document"
            items={[
              { label: 'Export as HTML', hint: '.html', onSelect: () => void exportAs('html') },
              { label: 'Export as Word', hint: '.doc', onSelect: () => void exportAs('doc') },
              { label: 'Copy as rich text', hint: 'clipboard', onSelect: () => void copyRich() },
            ]}
          />
        </div>
      ) : null}

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
        ) : mdTab ? (
          <div className={`editor-md view-${mdView}`}>
            {mdView !== 'preview' ? <div className="editor-md-edit">{renderPane('primary', mdTab)}</div> : null}
            {mdView !== 'edit' ? <MarkdownPreview content={mdTab.content} currentPath={mdTab.path} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} /> : null}
            {review ? <ReviewOverlay review={review} onDecision={setDecision} onAll={setAllDecisions} onApply={applyReviewToDoc} onCancel={() => setReview(null)} /> : null}
          </div>
        ) : (
          <div className={`editor-split${secondary ? ' two' : ' one'}`}>
            {renderPane('primary', active)}
            {secondary ? renderPane('secondary', secondary) : null}
          </div>
        )}
      </div>

      {mdTab ? <WritingAssistant currentPath={mdTab.path} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} /> : null}

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
