/**
 * ANNOTATION-RECORDS (0.4.15) — the Annotations panel: per-workspace durable
 * feedback records anchored to a plan / requirement / artifact / doc / message
 * / diff / file / review finding. Lists this workspace's annotations (filterable
 * by status + target kind), shows a selected annotation's detail (body, anchor,
 * suggested code, target link, link counts), lets you change its lifecycle
 * status, and exports the (filtered) set as agent-readable markdown into the
 * chat session. Pure view logic lives in lib/annotations/annotationsView. Wraps
 * the CLI annotationStore over the host endpoints — no parallel state.
 */
import React, { useState } from 'react';
import type { AnnotationRecord, AnnotationStatus, AnnotationTargetKind } from '@kinqs/brainrouter-types';
import { Button } from '../../components/primitives/Button.js';
import { Chip } from '../../components/primitives/Badge.js';
import {
  sortAnnotations, annotationCounts, severityClass, statusClass, anchorLabel, annotationLinkCounts,
  ANNOTATION_STATUS_OPTIONS, ANNOTATION_TARGET_KIND_OPTIONS,
} from '../../lib/annotations/annotationsView.js';

// §6 — the host augments each record with a transient `stale` flag (computed by
// re-hashing the anchored lines), so the panel works with this row shape.
type AnnotationRow = AnnotationRecord & { stale?: boolean };

const TARGET_KIND_FILTER: Array<'' | AnnotationTargetKind> = ['', ...ANNOTATION_TARGET_KIND_OPTIONS];
const STATUS_FILTER: Array<'' | AnnotationStatus> = ['', ...ANNOTATION_STATUS_OPTIONS];

export function AnnotationsPanel({ annotations, onSetStatus, onExport, onSelectTarget, onAddComment }: {
  annotations: AnnotationRow[];
  onSetStatus: (id: string, status: AnnotationStatus) => void;
  onExport: (filter: { status?: AnnotationStatus; targetKind?: AnnotationTargetKind }) => void;
  onSelectTarget?: (a: AnnotationRecord) => void;
  onAddComment?: (id: string, body: string) => void;
}): React.ReactElement {
  const [statusFilter, setStatusFilter] = useState<'' | AnnotationStatus>('');
  const [kindFilter, setKindFilter] = useState<'' | AnnotationTargetKind>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = annotations.filter((a) =>
    (!statusFilter || a.status === statusFilter) && (!kindFilter || a.type === kindFilter));
  const sorted = sortAnnotations(filtered) as AnnotationRow[]; // sortAnnotations only reorders — the transient `stale` field rides along.
  const counts = annotationCounts(annotations);
  // Keep a valid selection: the first row, unless the user picked one still in view.
  const selected = sorted.find((a) => a.id === selectedId) ?? sorted[0] ?? null;

  const exportFilter = (): { status?: AnnotationStatus; targetKind?: AnnotationTargetKind } => {
    const f: { status?: AnnotationStatus; targetKind?: AnnotationTargetKind } = {};
    if (statusFilter) f.status = statusFilter;
    if (kindFilter) f.targetKind = kindFilter;
    return f;
  };

  return (
    <div className="scroll annot-panel">
      <div className="sched-add">
        <div className="annot-filters">
          <label className="req-select">
            <span>Status</span>
            <select className="filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | AnnotationStatus)}>
              {STATUS_FILTER.map((s) => <option key={s || 'all'} value={s}>{s || 'all'}</option>)}
            </select>
          </label>
          <label className="req-select">
            <span>Target</span>
            <select className="filter" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as '' | AnnotationTargetKind)}>
              {TARGET_KIND_FILTER.map((k) => <option key={k || 'all'} value={k}>{k || 'all'}</option>)}
            </select>
          </label>
          <Button disabled={filtered.length === 0}
            title={filtered.length === 0 ? 'No annotations to export' : 'Drop the filtered annotations into the chat as agent-readable feedback'}
            onClick={() => onExport(exportFilter())}>Export feedback</Button>
        </div>
        <div className="annot-counts">
          <Chip>{counts.open} open</Chip>
          <Chip>{counts.accepted} accepted</Chip>
          <Chip>{counts.resolved} resolved</Chip>
          <Chip>{counts.total} total</Chip>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">No annotations{statusFilter || kindFilter ? ' match this filter' : ' yet'}. Use “Annotate” on a review finding, or annotate a plan / file / doc to capture durable feedback.</div>
      ) : (
        <>
          {sorted.map((a) => {
            const loc = anchorLabel(a.anchor);
            return (
              <button key={a.id} className={`req-row${selected?.id === a.id ? ' active' : ''}`} onClick={() => setSelectedId(a.id)}>
                <span className={`req-prio sev sev-${severityClass(a.severity)}`} title={`severity: ${a.severity ?? 'info'}`}>{a.severity ?? 'info'}</span>
                <span className={`req-status ${statusClass(a.status)}`}>{a.status}</span>
                <span className="annot-kind">{a.type}</span>
                <span className="req-title">{a.body}</span>
                {a.stale ? <span className="annot-stale" title="The anchored code has changed since this annotation was made">⚠ stale</span> : null}
                {loc ? <span className="annot-anchor" title={loc}>{loc}</span> : null}
                <span className="req-id">{a.id}</span>
              </button>
            );
          })}

          {selected ? <AnnotationDetail ann={selected} onSetStatus={onSetStatus} onSelectTarget={onSelectTarget} onAddComment={onAddComment} /> : null}
        </>
      )}

      <div className="sched-note">Annotations persist in <code>.brainrouter/cli/annotations.json</code> — shared with the CLI. “Export feedback” drops the filtered set into this chat as markdown the agent can act on.</div>
    </div>
  );
}

function AnnotationDetail({ ann, onSetStatus, onSelectTarget, onAddComment }: {
  ann: AnnotationRow;
  onSetStatus: (id: string, status: AnnotationStatus) => void;
  onSelectTarget?: (a: AnnotationRecord) => void;
  onAddComment?: (id: string, body: string) => void;
}): React.ReactElement {
  const links = annotationLinkCounts(ann);
  const loc = anchorLabel(ann.anchor);
  const [comment, setComment] = useState('');
  const submitComment = (): void => {
    if (!onAddComment || !comment.trim()) return;
    onAddComment(ann.id, comment.trim());
    setComment('');
  };
  return (
    <div className="req-detail">
      <div className="req-detail-head">
        <span className={`req-prio sev sev-${severityClass(ann.severity)}`}>{ann.severity ?? 'info'}</span>
        <span className="req-detail-title">{ann.type}</span>
        <span className="req-id">{ann.id}</span>
      </div>

      <div className="req-desc">{ann.body}</div>

      <div className="req-controls">
        <label className="req-select">
          <span>Status</span>
          <select className="filter" value={ann.status} onChange={(e) => onSetStatus(ann.id, e.target.value as AnnotationStatus)}>
            {ANNOTATION_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {ann.targetId && onSelectTarget ? (
          <Button title="Reveal this annotation's target" onClick={() => onSelectTarget(ann)}>Open target</Button>
        ) : null}
      </div>

      {loc || ann.anchor?.selectedText ? (
        <>
          <div className="tasks-section"><span>Anchor{ann.stale ? <span className="annot-stale"> ⚠ stale — code changed</span> : null}</span></div>
          {loc ? <div className="annot-anchor-line">{loc}</div> : null}
          {ann.anchor?.selectedText ? <pre className={`annot-quote${ann.stale ? ' stale' : ''}`}>{ann.anchor.selectedText}</pre> : null}
        </>
      ) : null}

      {ann.suggestedText ? (
        <>
          <div className="tasks-section"><span>Suggested</span></div>
          <pre className="annot-suggested">{ann.suggestedText}</pre>
        </>
      ) : null}

      <div className="tasks-section"><span>Thread{ann.comments?.length ? ` (${ann.comments.length})` : ''}</span></div>
      {ann.comments?.length ? (
        <ul className="annot-thread">
          {ann.comments.map((c) => (
            <li key={c.id} className="annot-comment">
              <div className="annot-comment-meta">{c.author ? <span className="annot-comment-author">{c.author}</span> : null}<span className="dim">{fmtTime(c.createdAt)}</span></div>
              <div className="annot-comment-body">{c.body}</div>
            </li>
          ))}
        </ul>
      ) : <div className="empty">No comments yet.</div>}
      {onAddComment ? (
        <div className="sched-add-row">
          <input className="filter" placeholder="add a comment to this thread" value={comment}
            onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitComment(); }} />
          <button className="sched-add-btn" onClick={submitComment} disabled={!comment.trim()}>Comment</button>
        </div>
      ) : null}

      <div className="tasks-section"><span>Links</span></div>
      <div className="req-links">
        {ann.targetId ? <Chip>target {ann.targetId}</Chip> : null}
        {ann.requirementId ? <Chip>req {ann.requirementId}</Chip> : null}
        {ann.taskId ? <Chip>task {ann.taskId}</Chip> : null}
        {ann.artifactId ? <Chip>artifact {ann.artifactId}</Chip> : null}
        <Chip>{links.memory} memor{links.memory === 1 ? 'y' : 'ies'}</Chip>
      </div>
    </div>
  );
}

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
