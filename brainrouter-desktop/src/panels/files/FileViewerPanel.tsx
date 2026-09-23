/** The File panel: a read-only, syntax-highlighted view of one opened file. */
import React from 'react';
import { Icon } from '../../icons.js';
import { CodeBlock, langForPath } from '../code.js';
import { NotebookView } from './NotebookView.js';

export function FileViewerPanel({ view }: {
  view: { path: string; content: string; error?: string } | null;
}): React.ReactElement {
  if (!view) return <div className="empty">Open a file from the Files panel or a diff.</div>;
  if (view.error) return <div className="empty">✗ {view.error}</div>;
  // ADR-051 D3 — a Jupyter notebook renders as cells (prose, code, plots) with a
  // Raw JSON toggle, instead of a wall of nbformat JSON.
  const isNotebook = /\.ipynb$/i.test(view.path);
  return (
    <>
      <div className="pathbar" title={view.path}>
        <span className="path-text">{view.path}</span>
        <button className="icon-btn" title="Copy contents" onClick={() => void navigator.clipboard.writeText(view.content)}><Icon name="copy" size={13} /></button>
      </div>
      <div className="scroll code-view">
        {isNotebook
          ? <NotebookView content={view.content} />
          : <CodeBlock code={view.content} language={langForPath(view.path)} showLineNumbers />}
      </div>
    </>
  );
}
