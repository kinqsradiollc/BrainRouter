/**
 * The full modern-code-editor option set for the Monaco panes, factored out of
 * EditorPanel's render so the pane component stays legible. `.md`/prose tabs guard
 * a few options (no minimap, ghost-text on, always-wrap, no quick-suggest);
 * everything else is the complete editor experience. Byte-identical to the object
 * that previously lived inline.
 */
import { editorFontFamily } from '../../lib/editor/monacoEnv.js';
import { MARKDOWN_FILE } from '../../lib/docs/markdownExport.js';
import { type EditorTab } from '../../lib/editor/editorModel.js';

export function monacoOptions(tab: EditorTab, minimap: boolean, wordWrap: boolean): Record<string, unknown> {
  return {
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
  };
}
