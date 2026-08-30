/**
 * ADR-051 D3 — a read-only RENDERED view of a Jupyter notebook (.ipynb) in the
 * File panel: markdown cells through the chat Markdown renderer, code cells
 * through the same highlighter as any file, and outputs shown honestly — text as
 * preformatted blocks, plots as images, errors named. A Raw JSON toggle shows the
 * exact bytes (the markdown-mode pattern: rendered first, source one click away).
 *
 * All parsing lives in the browser-safe core module; this file is a thin consumer
 * of `NotebookView`/`NotebookRenderCell` and renders nothing the parser didn't
 * already type.
 */
import React, { useMemo, useState } from 'react';
import remarkGfm from 'remark-gfm';
import { parseNotebookForRender, type NotebookRenderCell } from '@kinqs/brainrouter-core/agent/notebook';
import { Markdown, MD_COMPONENTS } from '../../chat/markdown.js';
import { CodeBlock } from '../code.js';

function CellOutputs({ cell }: { cell: NotebookRenderCell }): React.ReactElement | null {
  if (cell.outputs.length === 0) return null;
  return (
    <div className="nb-outputs">
      {cell.outputs.map((out, i) => {
        if (out.kind === 'image') return <img key={i} className="nb-output-img" src={out.dataUri} alt={`output ${out.mime}`} />;
        if (out.kind === 'error') return <pre key={i} className="nb-output nb-output-error">{`${out.ename}: ${out.evalue}${out.traceback ? `\n${out.traceback}` : ''}`}</pre>;
        if (out.kind === 'text') return <pre key={i} className="nb-output">{out.text}</pre>;
        return <div key={i} className="nb-output nb-output-other">[{out.mime}]</div>;
      })}
    </div>
  );
}

function NotebookCell({ cell }: { cell: NotebookRenderCell }): React.ReactElement {
  if (cell.type === 'markdown') {
    return (
      <div className="nb-cell nb-cell-md md">
        <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{cell.source}</Markdown>
      </div>
    );
  }
  if (cell.type === 'raw') {
    return <div className="nb-cell nb-cell-raw"><pre className="nb-output">{cell.source}</pre></div>;
  }
  return (
    <div className="nb-cell nb-cell-code">
      <div className="nb-cell-gutter">{cell.execution === null ? '[ ]' : `[${cell.execution}]`}</div>
      <div className="nb-cell-body">
        <CodeBlock code={cell.source} language="python" />
        <CellOutputs cell={cell} />
      </div>
    </div>
  );
}

export function NotebookView({ content }: { content: string }): React.ReactElement {
  const view = useMemo(() => parseNotebookForRender(content), [content]);
  const [raw, setRaw] = useState(false);

  // Not a valid notebook → show the raw bytes (no toggle; there is nothing to render).
  if (!view) return <CodeBlock code={content} language="json" showLineNumbers />;

  return (
    <div className="nb-view">
      <div className="nb-toolbar">
        <span className="nb-meta">{view.cells.length} cell{view.cells.length === 1 ? '' : 's'}{view.nbformat ? ` · nbformat ${view.nbformat}` : ''}</span>
        <button className="btn nb-raw-toggle" onClick={() => setRaw((r) => !r)}>{raw ? 'Rendered' : 'Raw JSON'}</button>
      </div>
      {raw
        ? <CodeBlock code={content} language="json" showLineNumbers />
        : view.cells.map((cell) => <NotebookCell key={cell.index} cell={cell} />)}
    </div>
  );
}
