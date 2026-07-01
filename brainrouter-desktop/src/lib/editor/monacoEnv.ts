/**
 * Monaco bootstrap — imported ONCE before the first <Editor> mounts (EditorPanel).
 *
 * Two CSP-critical choices (see index.html CSP + the blueprint):
 *  1. Workers via Vite `?worker` imports (the `getWorker` form), NOT the default
 *     `getWorkerUrl`/blob worker — blob/CDN workers are blocked by the renderer's
 *     `default-src 'self'` once packaged. `?worker` emits same-origin chunks.
 *  2. `loader.config({ monaco })` so @monaco-editor/react uses the BUNDLED monaco
 *     instead of fetching the AMD loader from a CDN (also blocked by the CSP).
 */
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import { loader } from '@monaco-editor/react';
import { isMonacoHex, normalizedColorToHex } from './monacoColor.js';

let installed = false;

/** Read a CSS custom property off :root as a literal (Monaco can't use var()). */
function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Monaco's theme parser only accepts hex colors — `editor.foreground`/`background`
// flow into the token theme, which THROWS "Illegal value for token color" on
// anything else, and every other `colors` entry is run through `Color.fromHex`
// (a non-hex value silently becomes red). Our palette (theme.css) is authored in
// `hsl(...)`, so each value must be normalized to hex before it reaches Monaco.
let colorProbe: CanvasRenderingContext2D | null | undefined;
function toMonacoHex(value: string, fallback: string): string {
  const v = (value || '').trim();
  if (!v) return fallback;
  if (isMonacoHex(v)) return v; // already #rgb/#rgba/#rrggbb/#rrggbbaa
  if (typeof document === 'undefined') return fallback;
  if (colorProbe === undefined) colorProbe = document.createElement('canvas').getContext('2d');
  if (!colorProbe) return fallback;
  // Seed with the fallback so an unparseable value degrades to it (a fresh assign
  // leaves the previous probe value untouched on parse failure).
  colorProbe.fillStyle = fallback;
  colorProbe.fillStyle = v; // the canvas normalizes any valid CSS color
  return normalizedColorToHex(colorProbe.fillStyle, fallback); // '#rrggbb' | 'rgba(...)' → hex
}

/** Read a CSS custom property as a Monaco-safe hex color (resolves hsl/rgb/named → hex). */
function cssColor(name: string, fallback: string): string {
  return toMonacoHex(cssVar(name, fallback), fallback);
}

/** The mono font Monaco should paint with (matches CodeBlock / the rest of the UI). */
export function editorFontFamily(): string {
  return cssVar('--mono', 'ui-monospace, SFMono-Regular, Menlo, monospace');
}

/** Define the BrainRouter dark + light Monaco themes from the LIVE app palette. */
function defineThemes(): void {
  // Dark (graphite) — colors are read live from theme.css and normalized to hex
  // (the palette is authored in hsl, which Monaco rejects).
  monaco.editor.defineTheme('brainrouter-dark', {
    base: 'vs-dark',
    inherit: true,
    // Standard dark-editor syntax palette (the familiar "Dark+" token colours):
    // comments green, strings salmon, keywords blue, control-flow violet, numbers
    // sage, types teal, functions sand, variables sky. Token foregrounds are bare
    // hex (Monaco rule syntax).
    rules: [
      { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'string.escape', foreground: 'D7BA7D' },
      { token: 'regexp', foreground: 'D16969' },
      { token: 'keyword', foreground: '569CD6' },
      { token: 'keyword.control', foreground: 'C586C0' },
      { token: 'keyword.operator', foreground: 'D4D4D4' },
      { token: 'operator', foreground: 'D4D4D4' },
      { token: 'delimiter', foreground: 'D4D4D4' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'type', foreground: '4EC9B0' },
      { token: 'type.identifier', foreground: '4EC9B0' },
      { token: 'namespace', foreground: '4EC9B0' },
      { token: 'class', foreground: '4EC9B0' },
      { token: 'interface', foreground: '4EC9B0' },
      { token: 'struct', foreground: '4EC9B0' },
      { token: 'enum', foreground: '4EC9B0' },
      { token: 'function', foreground: 'DCDCAA' },
      { token: 'support.function', foreground: 'DCDCAA' },
      { token: 'variable', foreground: '9CDCFE' },
      { token: 'variable.predefined', foreground: '4FC1FF' },
      { token: 'constant', foreground: '4FC1FF' },
      { token: 'tag', foreground: '569CD6' },
      { token: 'tag.id', foreground: '9CDCFE' },
      { token: 'attribute.name', foreground: '9CDCFE' },
      { token: 'attribute.value', foreground: 'CE9178' },
      { token: 'metatag', foreground: '569CD6' },
      { token: 'metatag.content.html', foreground: 'CE9178' },
      { token: 'string.key.json', foreground: '9CDCFE' },
      { token: 'string.value.json', foreground: 'CE9178' },
      { token: 'emphasis', fontStyle: 'italic' },
      { token: 'strong', fontStyle: 'bold' },
    ],
    colors: {
      'editor.background': '#1E1E1E',
      'editor.foreground': '#D4D4D4',
      'editorLineNumber.foreground': '#858585',
      'editorLineNumber.activeForeground': '#C6C6C6',
      'editorCursor.foreground': '#AEAFAD',
      'editor.selectionBackground': '#264F78',
      'editor.inactiveSelectionBackground': '#3A3D41',
      'editor.selectionHighlightBackground': '#ADD6FF26',
      'editor.wordHighlightBackground': '#575757B8',
      'editor.wordHighlightStrongBackground': '#004972B8',
      'editor.lineHighlightBackground': '#2A2D2E',
      'editor.lineHighlightBorder': '#00000000',
      'editor.findMatchBackground': '#515C6A',
      'editor.findMatchHighlightBackground': '#EA5C0055',
      'editorWidget.background': '#252526',
      'editorWidget.border': '#454545',
      'editorSuggestWidget.background': '#252526',
      'editorSuggestWidget.selectedBackground': '#04395E',
      'editorHoverWidget.background': '#252526',
      'editorIndentGuide.background1': '#404040',
      'editorIndentGuide.activeBackground1': '#707070',
      'editorGutter.background': '#1E1E1E',
      'editorWhitespace.foreground': '#3B3B3B',
      'editorBracketMatch.background': '#0064001A',
      'editorBracketMatch.border': '#888888',
      'editorBracketHighlight.foreground1': '#FFD700',
      'editorBracketHighlight.foreground2': '#DA70D6',
      'editorBracketHighlight.foreground3': '#179FFF',
      'editorError.foreground': '#F44747',
      'editorWarning.foreground': '#CCA700',
      'editorInfo.foreground': '#3794FF',
      'diffEditor.insertedTextBackground': '#9bb95533',
      'diffEditor.removedTextBackground': '#ff000033',
      'diffEditor.insertedLineBackground': '#9bb9551a',
      'diffEditor.removedLineBackground': '#ff00001a',
      'editorGutter.addedBackground': '#587C0C',
      'editorGutter.deletedBackground': '#94151B',
      'editorGutter.modifiedBackground': '#0C7D9D',
      'scrollbarSlider.background': '#79797966',
      'scrollbarSlider.hoverBackground': '#646464B3',
      'scrollbarSlider.activeBackground': '#BFBFBF66',
      'editorOverviewRuler.border': '#7F7F7F4D',
      'editorStickyScroll.background': '#1E1E1E',
    },
  });
  monaco.editor.defineTheme('brainrouter-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': cssColor('--bg', '#ffffff'),
      'editor.foreground': cssColor('--text', '#1f2328'),
      'editor.lineHighlightBackground': cssColor('--surface', '#f6f8fa'),
      'editor.selectionBackground': '#0969da2e',
      'editor.selectionHighlightBackground': '#0969da1a',
      'editorCursor.foreground': cssColor('--accent', '#0969da'),
      'editorError.foreground': cssColor('--err', '#9a6700'),
      'editorWarning.foreground': cssColor('--warn', '#9a6700'),
      'diffEditor.insertedTextBackground': '#1a7f372e',
      'diffEditor.removedTextBackground': '#9a67002e',
    },
  });
}

/** The Monaco theme id for the app's current data-theme. */
export function editorTheme(): string {
  const t = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null;
  return t === 'light' ? 'brainrouter-light' : 'brainrouter-dark';
}

/** Idempotent: wire workers, point the react loader at bundled monaco, define themes. */
export function installMonaco(): void {
  if (installed) return;
  installed = true;
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_id, label) {
      if (label === 'json') return new jsonWorker();
      if (label === 'typescript' || label === 'javascript') return new tsWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
      return new editorWorker();
    },
  };
  loader.config({ monaco });
  defineThemes();
  // Re-read the palette + re-apply whenever the app theme flips, so the editor
  // tracks the active theme instead of the one that happened to be live at mount.
  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => {
      defineThemes();
      monaco.editor.setTheme(editorTheme());
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
}

export { monacoLanguage } from './language.js';
