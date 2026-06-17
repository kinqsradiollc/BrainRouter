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
      // Selection = a subtle BLUE accent tint (never a raw red/green block).
      'editor.selectionBackground': 'rgba(88,166,255,0.20)',
      'editor.inactiveSelectionBackground': 'rgba(88,166,255,0.10)',
      'editor.selectionHighlightBackground': 'rgba(88,166,255,0.12)',
      'editor.wordHighlightBackground': 'rgba(88,166,255,0.10)',
      'editor.findMatchBackground': 'rgba(210,153,34,0.40)',
      'editor.findMatchHighlightBackground': 'rgba(210,153,34,0.18)',
      'editorCursor.foreground': cssVar('--accent', '#58a6ff'),
      'editorWidget.background': cssVar('--raised', '#21262d'),
      'editorWidget.border': cssVar('--border', '#30363d'),
      'editorIndentGuide.background1': cssVar('--border', '#21262d'),
      'editorGutter.background': cssVar('--bg', '#0d1117'),
      'editorWhitespace.foreground': '#30363d',
      'editorBracketMatch.background': 'rgba(88,166,255,0.16)',
      'editorBracketMatch.border': '#00000000',
      // Diagnostics — semantic foregrounds, no heavy backgrounds.
      'editorError.foreground': cssVar('--err', '#f85149'),
      'editorWarning.foreground': cssVar('--warn', '#d29922'),
      'editorInfo.foreground': cssVar('--accent', '#58a6ff'),
      // Diff: green add / red remove, as ACCESSIBLE tints (intentional diff state).
      'diffEditor.insertedTextBackground': 'rgba(63,185,80,0.22)',
      'diffEditor.removedTextBackground': 'rgba(248,81,73,0.22)',
      'diffEditor.insertedLineBackground': 'rgba(63,185,80,0.10)',
      'diffEditor.removedLineBackground': 'rgba(248,81,73,0.10)',
      // Change gutter ticks use the semantic add/del/modify tokens.
      'editorGutter.addedBackground': cssVar('--ok', '#3fb950'),
      'editorGutter.deletedBackground': cssVar('--err', '#f85149'),
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
      'editor.selectionBackground': 'rgba(9,105,218,0.18)',
      'editor.selectionHighlightBackground': 'rgba(9,105,218,0.10)',
      'editorCursor.foreground': cssVar('--accent', '#0969da'),
      'editorError.foreground': cssVar('--err', '#cf222e'),
      'editorWarning.foreground': cssVar('--warn', '#9a6700'),
      'diffEditor.insertedTextBackground': 'rgba(26,127,55,0.18)',
      'diffEditor.removedTextBackground': 'rgba(207,34,46,0.18)',
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
