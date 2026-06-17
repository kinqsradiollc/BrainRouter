/**
 * ARTIFACT-RECORDS (0.4.15) — the Artifacts panel: per-workspace durable
 * records for a workflow output a chat produces or reviews (design note,
 * sketch, HTML prototype, markdown report, verification summary, review
 * export). Lists this workspace's artifacts (filterable by kind + status),
 * shows a selected artifact's detail (kind / format / path / summary /
 * requirement link / memory count) plus a Preview area that renders markdown
 * through the app's chat markdown renderer or shows HTML/text source as a
 * read-only preformatted block, and lets you change an artifact's lifecycle
 * status. Pure view logic lives in lib/artifacts/artifactsView. Wraps the CLI
 * artifactStore over the host endpoints — no parallel state.
 */
import React, { useEffect, useState } from 'react';
import type { ArtifactRecord, ArtifactKind, ArtifactStatus, AnnotationRecord } from '@kinqs/brainrouter-types';
import remarkGfm from 'remark-gfm';
import { Markdown, MD_COMPONENTS } from '../chat/markdown.js';
import { Button } from '../components/Button.js';
import { Chip } from '../components/Badge.js';
import {
  sortArtifacts, artifactCounts, kindLabel, statusClass,
  ARTIFACT_KIND_OPTIONS, ARTIFACT_STATUS_OPTIONS,
} from '../lib/artifacts/artifactsView.js';

const KIND_FILTER: Array<'' | ArtifactKind> = ['', ...ARTIFACT_KIND_OPTIONS];
const STATUS_FILTER: Array<'' | ArtifactStatus> = ['', ...ARTIFACT_STATUS_OPTIONS];

export function ArtifactsPanel({ artifacts, annotations, onCreate, onSetStatus, onPreview, onSave, onAnnotate }: {
  artifacts: ArtifactRecord[];
  /** All workspace annotations — the detail filters to the selected artifact by targetId. */
  annotations?: AnnotationRecord[];
  onCreate?: (title: string) => void;
  onSetStatus: (id: string, status: ArtifactStatus) => void;
  /** Resolve the artifact's content (file via the safe workspace read, or inline). */
  onPreview: (a: ArtifactRecord) => void;
  /** §12 write-workspace — persist edited content (file-backed write or inline update). */
  onSave?: (id: string, content: string) => void;
  /** §8 — capture an annotation anchored to this artifact. */
  onAnnotate?: (a: ArtifactRecord, body: string, block?: string) => void;
}): React.ReactElement {
  const [kindFilter, setKindFilter] = useState<'' | ArtifactKind>('');
  const [statusFilter, setStatusFilter] = useState<'' | ArtifactStatus>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');

  const filtered = artifacts.filter((a) =>
    (!kindFilter || a.kind === kindFilter) && (!statusFilter || a.status === statusFilter));
  const sorted = sortArtifacts(filtered);
  const counts = artifactCounts(artifacts);
  // Keep a valid selection: the first row, unless the user picked one still in view.
  const selected = sorted.find((a) => a.id === selectedId) ?? sorted[0] ?? null;

  const submitCreate = (): void => {
    if (!onCreate || !title.trim()) return;
    onCreate(title.trim());
    setTitle('');
  };

  return (
    <div className="scroll art-panel">
      <div className="sched-add">
        {onCreate ? (
          <div className="sched-add-row">
            <input className="filter" placeholder="new artifact title" value={title} onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitCreate(); }} />
            <button className="sched-add-btn" onClick={submitCreate}>Add</button>
          </div>
        ) : null}
        <div className="annot-filters">
          <label className="req-select">
            <span>Kind</span>
            <select className="filter" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as '' | ArtifactKind)}>
              {KIND_FILTER.map((k) => <option key={k || 'all'} value={k}>{k || 'all'}</option>)}
            </select>
          </label>
          <label className="req-select">
            <span>Status</span>
            <select className="filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | ArtifactStatus)}>
              {STATUS_FILTER.map((s) => <option key={s || 'all'} value={s}>{s || 'all'}</option>)}
            </select>
          </label>
        </div>
        <div className="annot-counts">
          <Chip>{counts.draft} draft</Chip>
          <Chip>{counts.final} final</Chip>
          <Chip>{counts.archived} archived</Chip>
          <Chip>{counts.total} total</Chip>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">No artifacts{kindFilter || statusFilter ? ' match this filter' : ' yet'}. Artifacts capture a workflow output a chat produces or reviews — a design note, sketch, report, verification summary, or review export.</div>
      ) : (
        <>
          {sorted.map((a) => (
            <button key={a.id} className={`req-row${selected?.id === a.id ? ' active' : ''}`} onClick={() => setSelectedId(a.id)}>
              <span className="annot-kind" title={`kind: ${a.kind}`}>{a.kind}</span>
              <span className={`req-status ${statusClass(a.status)}`}>{a.status}</span>
              <span className="req-title">{a.title}</span>
              <span className="art-format" title={`format: ${a.format}`}>{a.format}</span>
              <span className="req-id">{a.id}</span>
            </button>
          ))}

          {selected ? <ArtifactDetail art={selected} onSetStatus={onSetStatus} onPreview={onPreview} onSave={onSave} onAnnotate={onAnnotate}
            annotations={(annotations ?? []).filter((n) => n.targetId === selected.id)} /> : null}
        </>
      )}

      <div className="sched-note">Artifacts persist in <code>.brainrouter/cli/artifacts.json</code> — shared with the CLI. Preview renders markdown inline; HTML/text is shown as read-only source.</div>
    </div>
  );
}

function ArtifactDetail({ art, annotations, onSetStatus, onPreview, onSave, onAnnotate }: {
  art: ArtifactRecord;
  annotations: AnnotationRecord[];
  onSetStatus: (id: string, status: ArtifactStatus) => void;
  onPreview: (a: ArtifactRecord) => void;
  onSave?: (id: string, content: string) => void;
  onAnnotate?: (a: ArtifactRecord, body: string, block?: string) => void;
}): React.ReactElement {
  // Re-resolve the content whenever the selected artifact changes — a file-backed
  // artifact's content lives on disk, fetched through the host's safe read.
  useEffect(() => { onPreview(art); }, [art.id, art.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const content = art.content ?? '';
  // §12 write-workspace — an Edit toggle swaps the preview for an editable buffer.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  // Reset the draft whenever the resolved content changes (artifact switch / re-read).
  useEffect(() => { setDraft(content); setEditing(false); }, [art.id, content]);
  const [note, setNote] = useState('');
  const submitNote = (): void => {
    if (!onAnnotate || !note.trim()) return;
    onAnnotate(art, note.trim());
    setNote('');
  };
  return (
    <div className="req-detail">
      <div className="req-detail-head">
        <span className="annot-kind">{kindLabel(art.kind)}</span>
        <span className="req-detail-title">{art.title}</span>
        <span className="req-id">{art.id}</span>
      </div>

      {art.summary ? <div className="req-desc">{art.summary}</div> : null}

      <div className="req-controls">
        <label className="req-select">
          <span>Status</span>
          <select className="filter" value={art.status} onChange={(e) => onSetStatus(art.id, e.target.value as ArtifactStatus)}>
            {ARTIFACT_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <Chip>format: {art.format}</Chip>
      </div>

      {art.path ? <div className="annot-anchor-line">{art.path}</div> : null}

      <div className="tasks-section">
        <span>{editing ? 'Edit' : 'Preview'}</span>
        {onSave && (art.format === 'markdown' || art.format === 'text' || art.format === 'html') ? (
          editing ? (
            <span className="art-edit-actions">
              <Button onClick={() => { setDraft(content); setEditing(false); }}>Cancel</Button>
              <Button variant="primary" onClick={() => { onSave(art.id, draft); setEditing(false); }}>Save{art.path ? ' to file' : ''}</Button>
            </span>
          ) : (
            <Button title={art.path ? `Edit and write back to ${art.path}` : 'Edit the artifact content'} onClick={() => { setDraft(content); setEditing(true); }}>Edit</Button>
          )
        ) : null}
      </div>
      {editing
        ? <textarea className="art-edit" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        : <ArtifactPreview art={art} content={content} />}

      {onAnnotate ? (
        <>
          <div className="tasks-section"><span>Annotations{annotations.length ? ` (${annotations.length})` : ''}</span></div>
          {annotations.length ? (
            <ul className="annot-thread">
              {annotations.map((n) => (
                <li key={n.id} className="annot-comment">
                  <div className="annot-comment-meta">
                    <span className={`req-status ${statusClass(n.status as ArtifactStatus)}`}>{n.status}</span>
                    {n.severity ? <span className="dim">{n.severity}</span> : null}
                    <span className="req-id">{n.id}</span>
                  </div>
                  <div className="annot-comment-body">{n.body}</div>
                </li>
              ))}
            </ul>
          ) : <div className="empty">No annotations on this artifact yet.</div>}
          <div className="sched-add-row">
            <input className="filter" placeholder="annotate this artifact (markdown/HTML/text)" value={note}
              onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }} />
            <button className="sched-add-btn" onClick={submitNote} disabled={!note.trim()}>Annotate</button>
          </div>
        </>
      ) : null}

      <div className="tasks-section"><span>Links</span></div>
      <div className="req-links">
        {art.requirementId ? <Chip>req {art.requirementId}</Chip> : null}
        {art.taskId ? <Chip>task {art.taskId}</Chip> : null}
        {art.sessionKey ? <Chip>session</Chip> : null}
        <Chip>{art.linkedMemoryIds.length} memor{art.linkedMemoryIds.length === 1 ? 'y' : 'ies'}</Chip>
      </div>
    </div>
  );
}

function ArtifactPreview({ art, content }: { art: ArtifactRecord; content: string }): React.ReactElement {
  if (!content.trim()) {
    return <div className="empty">{art.path ? 'Loading preview…' : 'No content to preview.'}</div>;
  }
  // Markdown renders through the SAME renderer the chat uses (react-markdown +
  // remark-gfm, fenced code via the shared highlighter). HTML and plain text are
  // shown as read-only SOURCE — never executed — so a sandboxed iframe can land
  // as a later slice without re-plumbing this one.
  if (art.format === 'markdown') {
    return (
      <div className="art-preview md">
        <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{content}</Markdown>
      </div>
    );
  }
  return <pre className="annot-quote art-source">{content}</pre>;
}
