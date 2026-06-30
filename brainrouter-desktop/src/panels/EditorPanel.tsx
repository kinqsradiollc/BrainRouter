/**
 * T5 — the in-app code editor. Monaco with editable tabs, dirty indicators,
 * Save / Save All / Revert, and read-only previews for binary/oversized files.
 * All writes go through the host action:file-save (never the renderer fs); this
 * component is pure UI over the useEditor hook in App.
 *
 * Lazy-loaded (React.lazy in App) so Monaco's ~5MB only loads when the editor
 * first opens — it must not inflate first paint.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { hostQuery } from '../lib/hostQuery.js';
import { renderBody, htmlDoc, MARKDOWN_FILE } from '../lib/docs/markdownExport.js';
import { computeReviewChunks, applyReview, type ReviewDecision } from '@kinqs/brainrouter-core/dist/write/writeDiff.js';
import {
  MarkdownPreview, WritingAssistant, ReviewOverlay,
  registerMarkdownGhost, setActiveMarkdownModel,
  ACTION_LABEL, type InlineAction, type MonacoRange, type ReviewSession,
} from './editor/markdownMode.js';
import { BarMenu } from './editor/BarMenu.js';
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
  // ── Markdown mode (the folded-in Docs experience for .md/.markdown/.mdx).
  const [mdView, setMdView] = useState<'edit' | 'split' | 'preview'>(() => (localStorage.getItem('br-editor-mdview') as 'edit' | 'split' | 'preview') || 'split');
  const [review, setReview] = useState<ReviewSession | null>(null);
  const [mdStatus, setMdStatus] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => { localStorage.setItem('br-editor-mdview', mdView); }, [mdView]);

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

  // Markdown mode applies to a non-binary .md file in the primary pane (the code
  // split takes precedence, so two Monacos never fight a preview pane).
  const mdTab = active && !active.binary && !secondary && MARKDOWN_FILE.test(active.path) ? active : null;
  const mdEditor = (): Parameters<OnMount>[0] | null => editorRefs.current.primary;

  const exportAs = useCallback(async (kind: 'html' | 'doc') => {
    if (!mdTab) return;
    setMdStatus('Exporting…');
    const title = mdTab.path.split('/').pop() ?? 'document';
    const doc = htmlDoc(title, renderBody(mdTab.content), { word: kind === 'doc' });
    const outPath = `${mdTab.path.replace(/\.[^/.]+$/, '')}.${kind}`;
    const res = await hostQuery<{ ok?: boolean; error?: string }>('write-save', { path: outPath, content: doc });
    setMdStatus(res?.ok ? `Exported to ${outPath}` : `Export failed${res?.error ? `: ${res.error}` : ''}.`);
  }, [mdTab]);

  const copyRich = useCallback(async () => {
    if (!mdTab) return;
    const html = htmlDoc(mdTab.path.split('/').pop() ?? 'document', renderBody(mdTab.content));
    try {
      const clip = navigator.clipboard as Clipboard & { write?: (items: ClipboardItem[]) => Promise<void> };
      if (typeof ClipboardItem !== 'undefined' && clip.write) {
        await clip.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([mdTab.content], { type: 'text/plain' }) })]);
        setMdStatus('Copied as rich text.'); return;
      }
      await navigator.clipboard.writeText(mdTab.content);
      setMdStatus('Copied as plain text (rich text unavailable here).');
    } catch { setMdStatus('Copy failed — the clipboard is unavailable.'); }
  }, [mdTab]);

  const runInline = useCallback(async (action: InlineAction) => {
    const ed = mdEditor();
    const sel = ed?.getSelection();
    const model = ed?.getModel();
    if (!ed || !sel || sel.isEmpty() || !model || !mdTab) { setMdStatus('Select some text first.'); return; }
    const text = model.getValueInRange(sel);
    if (!text.trim()) { setMdStatus('Select some text first.'); return; }
    const range: MonacoRange = { startLineNumber: sel.startLineNumber, startColumn: sel.startColumn, endLineNumber: sel.endLineNumber, endColumn: sel.endColumn };
    setAiBusy(true); setMdStatus(`${ACTION_LABEL[action]}…`);
    const res = await hostQuery<{ text?: string; error?: string }>('write-inline-ai', { action, text, doc: mdTab.content });
    setAiBusy(false);
    if (!res || res.error || typeof res.text !== 'string') { setMdStatus(res?.error ? `Inline AI: ${res.error}` : 'Inline AI is unavailable (is a model configured?).'); return; }
    if (res.text === text) { setMdStatus('No change suggested.'); return; }
    setReview({ chunks: computeReviewChunks(text, res.text), decisions: {}, range, action });
    setMdStatus('');
  }, [mdTab]);

  const setDecision = useCallback((id: number, decision: ReviewDecision) => setReview((r) => (r ? { ...r, decisions: { ...r.decisions, [id]: decision } } : r)), []);
  const setAllDecisions = useCallback((decision: ReviewDecision) => setReview((r) => {
    if (!r) return r;
    const d: Record<number, ReviewDecision> = {};
    for (const c of r.chunks) if (c.op !== 'equal') d[c.id] = decision;
    return { ...r, decisions: d };
  }), []);
  const applyReviewToDoc = useCallback(() => setReview((r) => {
    if (!r) return null;
    const result = applyReview(r.chunks, r.decisions, 'accept');
    const ed = mdEditor();
    if (ed) { ed.executeEdits('inline-ai', [{ range: r.range, text: result, forceMoveMarkers: true }]); ed.focus(); }
    setMdStatus(`Applied — ${ACTION_LABEL[r.action]}.`);
    return null;
  }), []);

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
              // The full modern-code-editor feature set. `.md`/prose tabs guard a
              // few options (no minimap, ghost-text on, always-wrap, no
              // quick-suggest); everything else is the complete editor experience.
              options={{
                readOnly: tab.readOnly,
                // ── font + text ──
                fontFamily: editorFontFamily(),
                fontSize: 13,
                lineHeight: 19,
                fontLigatures: true,
                // ── view prefs (toolbar-toggled) ──
                minimap: { enabled: minimap && !MARKDOWN_FILE.test(tab.path) },
                wordWrap: (wordWrap || MARKDOWN_FILE.test(tab.path)) ? 'on' : 'off',
                wrappingIndent: 'same',
                inlineSuggest: { enabled: MARKDOWN_FILE.test(tab.path) }, // W4 ghost-text for prose
                // ── rendering / appearance ──
                lineNumbers: 'on',
                lineNumbersMinChars: 5,
                glyphMargin: true,
                renderLineHighlight: 'all',
                renderWhitespace: 'selection',
                renderControlCharacters: true,
                renderFinalNewline: 'on',
                roundedSelection: true,
                cursorStyle: 'line',
                cursorBlinking: 'blink',
                cursorSmoothCaretAnimation: 'on',
                cursorSurroundingLines: 3,
                scrollBeyondLastLine: false,
                scrollBeyondLastColumn: 4,
                overviewRulerLanes: 3,
                smoothScrolling: true,
                mouseWheelZoom: true,
                fastScrollSensitivity: 5,
                scrollPredominantAxis: true,
                stickyScroll: { enabled: true, maxLineCount: 5 },
                stopRenderingLineAfter: 10000,
                padding: { top: 8, bottom: 8 },
                scrollbar: { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 14, horizontalScrollbarSize: 14, useShadows: true },
                // ── syntax, brackets, colour swatches ──
                'semanticHighlighting.enabled': true,
                bracketPairColorization: { enabled: true },
                matchBrackets: 'always',
                guides: { indentation: true, highlightActiveIndentation: true, bracketPairs: true, bracketPairsHorizontal: 'active', highlightActiveBracketPair: true },
                colorDecorators: true,
                colorDecoratorsActivatedOn: 'clickAndHover',
                colorDecoratorsLimit: 500,
                unicodeHighlight: { ambiguousCharacters: true, invisibleCharacters: true },
                unusualLineTerminators: 'prompt',
                // ── folding ──
                folding: true,
                foldingStrategy: 'auto',
                foldingHighlight: true,
                showFoldingControls: 'mouseover',
                // ── IntelliSense: suggestions, hints, lenses ──
                quickSuggestions: MARKDOWN_FILE.test(tab.path) ? false : { other: true, comments: false, strings: false },
                quickSuggestionsDelay: 10,
                suggestOnTriggerCharacters: true,
                acceptSuggestionOnEnter: 'on',
                suggestSelection: 'first',
                snippetSuggestions: 'inline',
                tabCompletion: 'on',
                wordBasedSuggestions: 'matchingDocuments',
                suggest: { insertMode: 'insert', showStatusBar: false, preview: false, showInlineDetails: true },
                parameterHints: { enabled: true, cycle: true },
                inlayHints: { enabled: 'on' },
                codeLens: true,
                hover: { enabled: true, delay: 300, sticky: true, above: true },
                lightbulb: { enabled: 'onCode' },
                links: true,
                occurrencesHighlight: 'singleFile',
                selectionHighlight: true,
                linkedEditing: true,
                gotoLocation: { multiple: 'peek' },
                // ── auto-edit behaviour ──
                autoClosingBrackets: 'languageDefined',
                autoClosingQuotes: 'languageDefined',
                autoClosingComments: 'languageDefined',
                autoClosingDelete: 'auto',
                autoClosingOvertype: 'auto',
                autoSurround: 'languageDefined',
                autoIndent: 'full',
                formatOnPaste: false,
                formatOnType: false,
                dragAndDrop: true,
                dropIntoEditor: { enabled: true },
                pasteAs: { enabled: true },
                emptySelectionClipboard: true,
                copyWithSyntaxHighlighting: true,
                useTabStops: true,
                smartSelect: { selectLeadingAndTrailingWhitespace: true, selectSubwords: true },
                // ── multi-cursor + selection ──
                multiCursorModifier: 'alt',
                multiCursorPaste: 'spread',
                multiCursorMergeOverlapping: true,
                // ── find widget ──
                find: { cursorMoveOnType: true, seedSearchStringFromSelection: 'always', addExtraSpaceOnTop: true, loop: true },
                // ── desktop chrome ──
                contextmenu: true,
                selectionClipboard: true,
                // ── layout ──
                tabSize: 2,
                automaticLayout: true,
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
