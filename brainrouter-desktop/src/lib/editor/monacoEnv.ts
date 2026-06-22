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

let installed = false;

/** Read a CSS custom property off :root as a literal (Monaco can't use var()). */
function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** The mono font Monaco should paint with (matches CodeBlock / the rest of the UI). */
export function editorFontFamily(): string {
  return cssVar('--mono', 'ui-monospace, SFMono-Regular, Menlo, monospace');
}

/** Define the BrainRouter dark + light Monaco themes from the app palette. */
function defineThemes(): void {
  // Dark (GitHub-Midnight) — literals mirror theme.css :root.
  monaco.editor.defineTheme('brainrouter-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': cssVar('--bg', '#0d1117'),
      'editor.foreground': cssVar('--text', '#e6edf3'),
      'editorLineNumber.foreground': cssVar('--text-faint', '#6e7681'),
      'editorLineNumber.activeForeground': cssVar('--text-dim', '#9198a1'),
      'editor.lineHighlightBackground': cssVar('--surface', '#151a22'),
      'editor.lineHighlightBorder': '#00000000', // no boxed border around the active line
      // Selection = a subtle BLUE accent tint. Use hex-alpha literals because
      // Monaco theme color parsing is stricter than CSS custom properties.
      'editor.selectionBackground': '#58a6ff33',
      'editor.inactiveSelectionBackground': '#58a6ff1a',
      'editor.selectionHighlightBackground': '#58a6ff1f',
      'editor.wordHighlightBackground': '#58a6ff1a',
      'editor.findMatchBackground': '#d2992266',
      'editor.findMatchHighlightBackground': '#d299222e',
      'editorCursor.foreground': cssVar('--accent', '#58a6ff'),
      'editorWidget.background': cssVar('--raised', '#21262d'),
      'editorWidget.border': cssVar('--border', '#30363d'),
      'editorIndentGuide.background1': cssVar('--border', '#21262d'),
      'editorGutter.background': cssVar('--bg', '#0d1117'),
      'editorWhitespace.foreground': '#30363d',
      'editorBracketMatch.background': '#58a6ff29',
      'editorBracketMatch.border': '#00000000',
      // Diagnostics — semantic foregrounds, no heavy backgrounds.
      'editorError.foreground': cssVar('--err', '#e3b341'),
      'editorWarning.foreground': cssVar('--warn', '#d29922'),
      'editorInfo.foreground': cssVar('--accent', '#58a6ff'),
      // Diff: green add / amber remove, as accessible tints.
      'diffEditor.insertedTextBackground': '#3fb95038',
      'diffEditor.removedTextBackground': '#d2992238',
      'diffEditor.insertedLineBackground': '#3fb9501a',
      'diffEditor.removedLineBackground': '#d299221a',
      // Change gutter ticks use the semantic add/del/modify tokens.
      'editorGutter.addedBackground': cssVar('--ok', '#3fb950'),
      'editorGutter.deletedBackground': cssVar('--warn', '#d29922'),
      'editorGutter.modifiedBackground': cssVar('--accent', '#58a6ff'),
      'scrollbarSlider.background': 'rgba(110,118,129,0.20)',
      'scrollbarSlider.hoverBackground': 'rgba(110,118,129,0.30)',
      'scrollbarSlider.activeBackground': 'rgba(110,118,129,0.45)',
      'editorOverviewRuler.border': '#00000000',
    },
  });
  monaco.editor.defineTheme('brainrouter-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': cssVar('--bg', '#ffffff'),
      'editor.foreground': cssVar('--text', '#1f2328'),
      'editor.lineHighlightBackground': cssVar('--surface', '#f6f8fa'),
      'editor.selectionBackground': '#0969da2e',
      'editor.selectionHighlightBackground': '#0969da1a',
      'editorCursor.foreground': cssVar('--accent', '#0969da'),
      'editorError.foreground': cssVar('--err', '#9a6700'),
      'editorWarning.foreground': cssVar('--warn', '#9a6700'),
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
}

export { monacoLanguage } from './language.js';
