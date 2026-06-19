/**
 * One transcript row. A switch over the ChatRow kinds (user · assistant ·
 * tool-group · error · loading · cmd-out · status). Extracted + memoized at the
 * call site so streaming deltas / the per-second tick don't re-render the whole
 * history (every <Markdown> was re-parsing on every ~18ms delta — the lag source).
 *
 * The App owns the data + side effects; this component takes the row plus a
 * bounded set of callbacks (request a diff, dismiss an error, fork from here).
 */
import React from 'react';
import remarkGfm from 'remark-gfm';
import type { ChatRow } from '../types.js';
import { Icon } from '../icons.js';
import { fmtRel } from '../lib/format.js';
import { parseThink } from '../lib/chat/thinkParse.js';
import { Markdown, MD_COMPONENTS } from './markdown.js';
import { ToolGroup } from './ToolGroup.js';

export function MessageRow({ r, liveLast, inlineDiffs, onRequestDiff, onDismissError, onFork }: {
  r: ChatRow;
  liveLast: boolean;
  inlineDiffs: Record<string, string>;
  onRequestDiff: (file: string) => void;
  onDismissError: (id: number | string) => void;
  onFork: (ts: number) => void;
}): React.ReactElement | null {
  switch (r.kind) {
    case 'user': return (
      <div className="row user-row">
        <div className="user">{r.text}</div>
        <span className="msg-actions">
          <button className="icon-btn" title="Copy" onClick={() => void navigator.clipboard.writeText(r.text)}><Icon name="copy" size={11} /></button>
          <span className="msg-time">{fmtRel(r.ts)}</span>
        </span>
      </div>
    );
    case 'assistant': {
      // T10 — model-aware reasoning: lift a leading <think> block (DeepSeek-R1,
      // QwQ, etc.) out of the answer into a collapsible "Thought process" so it
      // doesn't render as literal markup. No-op for models that don't emit it.
      const { reasoning, visible } = parseThink(r.text);
      return (
      <div className="row assistant md">
        {reasoning ? (
          <details className="think-block">
            <summary>Thought process</summary>
            <div className="think-body md"><Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{reasoning}</Markdown></div>
          </details>
        ) : null}
        <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{visible}</Markdown>
        <span className="msg-actions">
          <button className="icon-btn" title="Copy" onClick={() => void navigator.clipboard.writeText(visible || r.text)}><Icon name="copy" size={11} /></button>
          <button className="icon-btn" title="Fork into a new chat from this message" onClick={() => onFork(r.ts)}><Icon name="fork" size={11} /></button>
          <span className="msg-time">{fmtRel(r.ts)}</span>
        </span>
      </div>
      );
    }
    case 'tool-group': return <div className="row"><ToolGroup row={r} live={liveLast} inlineDiffs={inlineDiffs} onRequestDiff={onRequestDiff} /></div>;
    case 'error': return (
      <div className="row">
        <div className="error-card">
          <button className="icon-btn tab-close-btn err-x" aria-label="Dismiss error" title="Dismiss error" onClick={() => onDismissError(r.id)}>
            <Icon name="close" size={11} />
          </button>
          <span className="error-icon"><Icon name="warn" size={15} /></span>
          <div className="error-title">{r.text}</div>
          <div className="error-advice">Try sending your message again — your draft was kept. If it keeps happening, check the host log.</div>
          {r.detail ? <div className="error-detail">{r.detail}</div> : null}
        </div>
      </div>
    );
    case 'loading': return <div className="row history-loading"><span className="spinner big" /></div>;
    case 'cmd-out': return (
      <div className="row">
        <div className="cmd-out">
          <div className="cmd-out-head">{r.cmd}</div>
          <pre>{r.lines.join('\n')}</pre>
        </div>
      </div>
    );
    case 'status': return <div className="row status">{r.text}</div>;
    default: return null;
  }
}
