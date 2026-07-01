/**
 * Markdown render + export helpers, shared by the Editor's Markdown mode (the
 * preview pane + HTML/DOC export + rich-text copy). Kept here so the editor and
 * any other surface render prose identically. Uses React.createElement (no JSX)
 * so this stays a plain .ts module.
 */
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { renderToStaticMarkup } from 'react-dom/server';

/** True for files that get the Markdown writing experience (preview, export, AI). */
export const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i;

// One print-styled stylesheet shared by every export target.
export const EXPORT_CSS = 'body{font:16px/1.65 -apple-system,system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.25rem;color:#1a1a1a}pre{background:#f4f4f5;padding:1rem;border-radius:8px;overflow:auto}code{font-family:ui-monospace,monospace;background:#f4f4f5;padding:.15em .35em;border-radius:4px}pre code{padding:0;background:none}blockquote{border-left:3px solid #ddd;margin:0;padding-left:1rem;color:#555}table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:.4em .7em}img{max-width:100%}@media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#e4e4e7}pre,code{background:#27272a}}';

/** Render a Markdown body to HTML (GFM: tables, strikethrough, task lists). */
export function renderBody(content: string): string {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, content));
}

/**
 * Wrap a rendered body in a self-contained HTML document. `word: true` adds the
 * Office namespaces + WordDocument block so a `.doc` file opens directly in Word.
 */
export function htmlDoc(title: string, body: string, opts?: { word?: boolean }): string {
  const ns = opts?.word ? ' xmlns:o="urn:schemas-microsoft-office:office" xmlns:w="urn:schemas-microsoft-office:word"' : '';
  const wordMeta = opts?.word ? '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->' : '';
  return `<!doctype html>
<html lang="en"${ns}><head><meta charset="utf-8">${wordMeta}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>${EXPORT_CSS}</style>
</head><body>${body}</body></html>`;
}
