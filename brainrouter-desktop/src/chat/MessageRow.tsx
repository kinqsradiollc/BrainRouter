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
import { ChangesetCard } from './ChangesetCard.js';
import { ArtifactCard } from './ArtifactCard.js';

function deliveryLabel(delivery: Extract<ChatRow, { kind: 'user' }>['delivery']): string {
  if (!delivery) return '';
  if (delivery.state === 'canceled') return 'Canceled';
  if (delivery.mode === 'queue') {
    if (delivery.state === 'queued') return delivery.position ? `Queued · ${delivery.position}` : 'Queued';
    if (delivery.state === 'running') return 'Queue · running';
    return 'Queue · delivered';
  }
  if (delivery.state === 'steered') return 'Steer · pending';
  if (delivery.receipt?.status === 'needs_user') return 'Steer · needs input';
  if (delivery.receipt?.status === 'pending' && delivery.receipt.classification === 'plan_change') {
    return 'Steer · revising plan';
  }
  if (delivery.receipt?.status === 'pending') return 'Steer · reconciling';
  if (delivery.receipt?.status === 'applied') {
    const classification = delivery.receipt.classification?.replace('_', ' ');
    const revision = delivery.receipt.resultingRevision
      ? ` · plan r${delivery.receipt.resultingRevision}`
      : '';
    return `Steer · ${classification ?? 'applied'}${revision}`;
  }
  if (delivery.state === 'applied') return 'Steer · applied';
  if (delivery.state === 'running') return 'Steer · follow-up';
  return 'Steer · delivered';
}

export function MessageRow({ r, liveLast, inlineDiffs, onRequestDiff, onOpenFile, onOpenDiff, onOpenPlan, onOpenArtifact, onDismissError, onFork, onRewind, onSaveToNotes, onAddToPlanner }: {
  r: ChatRow;
  liveLast: boolean;
  inlineDiffs: Record<string, string>;
  onRequestDiff: (file: string) => void;
  onOpenFile: (file: string) => void;
  onOpenDiff: (file: string) => void;
  onOpenPlan: () => void;
  onOpenArtifact: (id: string) => void;
  onDismissError: (id: number | string) => void;
  onFork: (ts: number) => void;
  onRewind: (ts: number) => void;
  /** ADR-029 C2 — Chat → Notes: the conclusion becomes a block citing the conversation. */
  onSaveToNotes: (text: string) => void;
  /** ADR-029 C2 — Chat → Planner: "remind me to…" becomes a task. */
  onAddToPlanner: (text: string) => void;
}): React.ReactElement | null {
  switch (r.kind) {
    case 'user': return (
      <div className="row user-row">
        <div className="user">
          {r.text}
          {r.delivery ? <span className={`delivery-badge ${r.delivery.mode} state-${r.delivery.state}`}>{deliveryLabel(r.delivery)}</span> : null}
        </div>
        <span className="msg-actions">
          <button className="icon-btn" title="Copy" onClick={() => void navigator.clipboard.writeText(r.text)}><Icon name="copy" size={11} /></button>
          <button className="icon-btn" title="Add to planner" aria-label="Add to planner" onClick={() => onAddToPlanner(r.text)}><Icon name="plan" size={11} /></button>
          <button className="icon-btn" title="Rewind the conversation to here" onClick={() => onRewind(r.ts)}><Icon name="arrow-left" size={11} /></button>
          <span className="msg-time">{fmtRel(r.ts)}</span>
        </span>
      </div>
    );
    case 'delivery': return (
      <div className="row delivery-row">
        <div className="delivery-source">Extension event</div>
        <div className="delivery-copy">{r.text}</div>
        <span className={`delivery-badge ${r.delivery.mode} state-${r.delivery.state}`}>{deliveryLabel(r.delivery)}</span>
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
          {/* ADR-029 C2 — the two moves a chat turn affords. The note cites the
              CONVERSATION rather than the turn, because a turn has no id that
              survives a rewind and a citation that quietly points elsewhere is
              worse than one that is a little coarser. */}
          <button className="icon-btn" title="Save to notes" aria-label="Save to notes" onClick={() => onSaveToNotes(visible || r.text)}><Icon name="note" size={11} /></button>
          <button className="icon-btn" title="Add to planner" aria-label="Add to planner" onClick={() => onAddToPlanner(visible || r.text)}><Icon name="plan" size={11} /></button>
          <button className="icon-btn" title="Fork into a new chat from this message" onClick={() => onFork(r.ts)}><Icon name="fork" size={11} /></button>
          <button className="icon-btn" title="Rewind the conversation to here" onClick={() => onRewind(r.ts)}><Icon name="arrow-left" size={11} /></button>
          <span className="msg-time">{fmtRel(r.ts)}</span>
        </span>
      </div>
      );
    }
    case 'tool-group': return <div className="row"><ToolGroup row={r} live={liveLast} inlineDiffs={inlineDiffs} onRequestDiff={onRequestDiff} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} /></div>;
    case 'changeset': return <div className="row"><ChangesetCard files={r.files} insertions={r.insertions} deletions={r.deletions} onOpenDiff={onOpenDiff} /></div>;
    case 'artifact': return <div className="row"><ArtifactCard artifactId={r.artifactId} title={r.title} format={r.format} artifactKind={r.artifactKind} version={r.version} action={r.action} onOpen={onOpenArtifact} /></div>;
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
    case 'briefing': {
      // The memory that was injected into the model BEFORE this turn. Collapsed
      // by default; expand to see every recalled record (type · priority · id ·
      // content) so the user knows exactly what context the model was given.
      const recs = r.records ?? [];
      const n = recs.length;
      return (
        <div className="row">
          <details className="briefing-block">
            <summary>
              <span className="briefing-title">Knowledge briefing</span>
              <span className="briefing-count">{n} saved {n === 1 ? 'item' : 'items'}</span>
              {r.sources.length ? <span className="briefing-sources" title={r.sources.join(', ')}>{r.sources.map((s) => s.replace(/^memory_/, '')).join(' · ')}</span> : null}
            </summary>
            <div className="briefing-body">
              {n === 0 ? (
                <div className="briefing-empty">No saved knowledge was recalled for this turn.</div>
              ) : recs.map((rec, i) => (
                <div className="briefing-rec" key={rec.id || i}>
                  <div className="briefing-rec-head">
                    {rec.type ? <span className="briefing-type">{rec.type}</span> : null}
                    {rec.source ? <span className="briefing-source-chip">{rec.source.replace(/^memory_/, '')}</span> : null}
                    {typeof rec.score === 'number' ? <span className="briefing-score">score {rec.score.toFixed(2)}</span> : null}
                    {typeof rec.priority === 'number' ? <span className="briefing-prio">priority {rec.priority}</span> : null}
                  </div>
                  {rec.content ? <div className="briefing-rec-body">{rec.content}</div> : <div className="briefing-empty">(no content)</div>}
                  <div className="briefing-rec-foot">
                    <code className="briefing-id" title={rec.id}>{rec.id}</code>
                    <button className="icon-btn briefing-copy" title="Copy record id" onClick={() => void navigator.clipboard.writeText(rec.id)}><Icon name="copy" size={10} /></button>
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      );
    }
    case 'status': return r.action === 'plan'
      ? <div className="row status"><button className="plan-link" title="Open the plan" onClick={() => onOpenPlan()}><Icon name="plan" size={12} /> {r.text} ›</button></div>
      : <div className="row status">{r.text}</div>;
    default: return null;
  }
}
