/** The File panel: a read-only, syntax-highlighted view of one opened file. */
import React from 'react';
import { Icon } from '../icons.js';
import { CodeBlock, langForPath } from './code.js';

export function FileViewerPanel({ view }: {
  view: { path: string; content: string; error?: string } | null;
}): React.ReactElement {
  if (!view) return <div className="empty">Open a file from the Files panel or a diff.</div>;
  if (view.error) return <div className="empty">✗ {view.error}</div>;
  return (
    <>
      <div className="pathbar" title={view.path}>
        <span className="path-text">{view.path}</span>
        <button className="icon-btn" title="Copy contents" onClick={() => void navigator.clipboard.writeText(view.content)}><Icon name="copy" size={13} /></button>
      </div>
      <div className="scroll code-view">
        <CodeBlock code={view.content} language={langForPath(view.path)} showLineNumbers />
      </div>
    </>
  );
}
