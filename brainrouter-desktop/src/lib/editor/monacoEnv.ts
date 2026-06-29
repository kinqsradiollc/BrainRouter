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
    rules: [],
    colors: {
      'editor.background': cssColor('--bg', '#0d1117'),
      'editor.foreground': cssColor('--text', '#e6edf3'),
      'editorLineNumber.foreground': cssColor('--text-faint', '#6e7681'),
      'editorLineNumber.activeForeground': cssColor('--text-dim', '#9198a1'),
      'editor.lineHighlightBackground': cssColor('--surface', '#151a22'),
      'editor.lineHighlightBorder': '#00000000', // no boxed border around the active line
      // Selection = a subtle BLUE accent tint (hex-alpha literals).
      'editor.selectionBackground': '#58a6ff33',
      'editor.inactiveSelectionBackground': '#58a6ff1a',
      'editor.selectionHighlightBackground': '#58a6ff1f',
      'editor.wordHighlightBackground': '#58a6ff1a',
      'editor.findMatchBackground': '#d2992266',
      'editor.findMatchHighlightBackground': '#d299222e',
      'editorCursor.foreground': cssColor('--accent', '#58a6ff'),
      'editorWidget.background': cssColor('--raised', '#21262d'),
      'editorWidget.border': cssColor('--border', '#30363d'),
      'editorIndentGuide.background1': cssColor('--border', '#21262d'),
      'editorGutter.background': cssColor('--bg', '#0d1117'),
      'editorWhitespace.foreground': '#30363d',
      'editorBracketMatch.background': '#58a6ff29',
      'editorBracketMatch.border': '#00000000',
      // Diagnostics — semantic foregrounds, no heavy backgrounds.
      'editorError.foreground': cssColor('--err', '#e3b341'),
      'editorWarning.foreground': cssColor('--warn', '#d29922'),
      'editorInfo.foreground': cssColor('--accent', '#58a6ff'),
      // Diff: green add / amber remove, as accessible tints.
      'diffEditor.insertedTextBackground': '#3fb95038',
      'diffEditor.removedTextBackground': '#d2992238',
      'diffEditor.insertedLineBackground': '#3fb9501a',
      'diffEditor.removedLineBackground': '#d299221a',
      // Change gutter ticks use the semantic add/del/modify tokens.
      'editorGutter.addedBackground': cssColor('--ok', '#3fb950'),
      'editorGutter.deletedBackground': cssColor('--warn', '#d29922'),
      'editorGutter.modifiedBackground': cssColor('--accent', '#58a6ff'),
      // hex-alpha equivalents of rgba(110,118,129, .20/.30/.45) — Monaco needs hex.
      'scrollbarSlider.background': '#6e768133',
      'scrollbarSlider.hoverBackground': '#6e76814d',
      'scrollbarSlider.activeBackground': '#6e768173',
      'editorOverviewRuler.border': '#00000000',
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
