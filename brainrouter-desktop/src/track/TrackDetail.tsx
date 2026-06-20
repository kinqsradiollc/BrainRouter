/**
 * Track — the work-item detail drawer. Slides in from the right when a card is
 * opened. Edit the fields, transition status, manage labels, add comments, see
 * the activity log, attach code/memory/dependency links, and add sub-tasks —
 * every change goes through the `ops` callbacks (host `track-*` queries).
 */
import React, { useState } from 'react';
import type { TrackProject, WorkItem, WorkItemPriority, Sprint } from '@kinqs/brainrouter-types';
import { Icon } from '../icons.js';
import { TYPE_ICON } from './TrackView.js';
import type { TrackOps } from './TrackView.js';

const PRIORITIES: WorkItemPriority[] = ['highest', 'high', 'medium', 'low', 'lowest'];

export function TrackDetail({ item, project, allItems, sprints, ops, onClose }: {
  item: WorkItem; project: TrackProject | null; allItems: WorkItem[]; sprints: Sprint[]; ops: TrackOps; onClose: () => void;
}): React.ReactElement {
  const [editTitle, setEditTitle] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [editDesc, setEditDesc] = useState(false);
  const [desc, setDesc] = useState(item.description ?? '');
  const [label, setLabel] = useState('');
  const [comment, setComment] = useState('');
  const [linkRef, setLinkRef] = useState('');
  const [linkKind, setLinkKind] = useState<'branch' | 'commit' | 'pull-request' | 'file'>('branch');
  const [subTitle, setSubTitle] = useState('');

  const states = project?.workflowStates ?? [];
  const subtasks = allItems.filter((w) => w.parentId === item.id);
  const epics = allItems.filter((w) => w.type === 'epic' && w.id !== item.id);

  const saveTitle = (): void => { if (title.trim() && title !== item.title) ops.update(item.key, { title: title.trim() }); setEditTitle(false); };
  const saveDesc = (): void => { if (desc !== (item.description ?? '')) ops.update(item.key, { description: desc }); setEditDesc(false); };
  const addLabel = (): void => { const l = label.trim(); if (l && !item.labels.includes(l)) ops.update(item.key, { labels: [...item.labels, l] }); setLabel(''); };
  const removeLabel = (l: string): void => ops.update(item.key, { labels: item.labels.filter((x) => x !== l) });

  return (
    <div className="track-detail-scrim" onClick={onClose}>
      <aside className="track-detail" onClick={(e) => e.stopPropagation()}>
        <header className="track-detail-head">
          <span className={`track-type track-type-${item.type}`}><Icon name={TYPE_ICON[item.type]} size={13} /></span>
          <span className="track-detail-key mono">{item.key}</span>
          <select className="track-detail-status" value={item.status} onChange={(e) => ops.transition(item.key, e.target.value)}>
            {states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="icon-btn track-detail-close" title="Close" onClick={onClose}><Icon name="close" size={13} /></button>
        </header>

        <div className="track-detail-body">
          {editTitle ? (
            <input className="track-detail-title-edit" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') { setTitle(item.title); setEditTitle(false); } }} />
          ) : (
            <h2 className="track-detail-title" onClick={() => { setTitle(item.title); setEditTitle(true); }}>{item.title}</h2>
          )}

          <div className="track-detail-fields">
            <Field label="Type"><span className="track-detail-pill">{item.type}</span></Field>
            <Field label="Priority">
              <select value={item.priority} onChange={(e) => ops.update(item.key, { priority: e.target.value as WorkItemPriority })}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Assignee">
              <input defaultValue={item.assignee ?? ''} placeholder="unassigned" onBlur={(e) => { const v = e.target.value.trim(); if (v !== (item.assignee ?? '')) ops.update(item.key, { assignee: v || undefined }); }} />
            </Field>
            <Field label="Sprint">
              <select value={item.sprintId ?? ''} onChange={(e) => ops.assignSprint(item.key, e.target.value || null)}>
                <option value="">— none —</option>
                {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            {item.type !== 'epic' ? (
              <Field label="Epic">
                <select value={item.epicId ?? ''} onChange={(e) => ops.update(item.key, { epicId: e.target.value || undefined })}>
                  <option value="">— none —</option>
                  {epics.map((ep) => <option key={ep.id} value={ep.id}>{ep.key} {ep.title}</option>)}
                </select>
              </Field>
            ) : null}
            <Field label="Points">
              <input type="number" min={0} defaultValue={item.storyPoints ?? ''} placeholder="—" onBlur={(e) => { const n = e.target.value ? Number(e.target.value) : undefined; if (n !== item.storyPoints) ops.update(item.key, { storyPoints: n }); }} />
            </Field>
          </div>

          <Field label="Labels">
            <div className="track-detail-labels">
              {item.labels.map((l) => <span key={l} className="track-label">{l}<button onClick={() => removeLabel(l)}>×</button></span>)}
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="+ label" onKeyDown={(e) => { if (e.key === 'Enter') addLabel(); }} />
            </div>
          </Field>

          <Section title="Description">
            {editDesc ? (
              <textarea className="track-detail-desc-edit" autoFocus value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={saveDesc} placeholder="Add a description…" />
            ) : (
              <div className="track-detail-desc" onClick={() => { setDesc(item.description ?? ''); setEditDesc(true); }}>{item.description || <span className="track-detail-muted">Add a description…</span>}</div>
            )}
          </Section>

          <Section title="Code links">
            <div className="track-detail-links">
              {item.codeLinks.map((c, i) => <span key={i} className="track-codelink"><Icon name={c.kind === 'branch' ? 'branch' : c.kind === 'file' ? 'file' : 'commit'} size={11} /> {c.ref}</span>)}
              {item.codeLinks.length === 0 ? <span className="track-detail-muted">No code links.</span> : null}
            </div>
            <div className="track-detail-addlink">
              <select value={linkKind} onChange={(e) => setLinkKind(e.target.value as typeof linkKind)}>
                <option value="branch">branch</option><option value="commit">commit</option><option value="pull-request">PR</option><option value="file">file</option>
              </select>
              <input value={linkRef} onChange={(e) => setLinkRef(e.target.value)} placeholder="ref (branch / sha / url / path)" onKeyDown={(e) => { if (e.key === 'Enter' && linkRef.trim()) { ops.link(item.key, { codeLinks: [{ kind: linkKind, ref: linkRef.trim() }] }); setLinkRef(''); } }} />
              <button onClick={() => { if (linkRef.trim()) { ops.link(item.key, { codeLinks: [{ kind: linkKind, ref: linkRef.trim() }] }); setLinkRef(''); } }}>Link</button>
            </div>
          </Section>

          <Section title={`Sub-tasks (${subtasks.length})`}>
            {subtasks.map((s) => (
              <div key={s.id} className="track-subtask"><span className={`track-cat track-cat-${s.statusCategory}`} /><span className="mono tl-key">{s.key}</span><span className="tl-title">{s.title}</span></div>
            ))}
            <div className="track-detail-addsub">
              <input value={subTitle} onChange={(e) => setSubTitle(e.target.value)} placeholder="+ sub-task" onKeyDown={(e) => { if (e.key === 'Enter' && subTitle.trim()) { ops.create({ title: subTitle.trim(), type: 'sub-task', status: states[0]?.id ?? 'todo' }); setSubTitle(''); } }} />
            </div>
          </Section>

          <Section title={`Comments (${item.comments.length})`}>
            {item.comments.map((c) => (
              <div key={c.id} className="track-comment-row"><span className="track-comment-author">{c.author}</span><span className="track-comment-body">{c.body}</span></div>
            ))}
            <div className="track-detail-addcomment">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment…" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && comment.trim()) { ops.comment(item.key, comment.trim()); setComment(''); } }} />
              <button disabled={!comment.trim()} onClick={() => { if (comment.trim()) { ops.comment(item.key, comment.trim()); setComment(''); } }}>Comment</button>
            </div>
          </Section>

          <Section title="Activity">
            <div className="track-activity">
              {[...item.activity].reverse().slice(0, 20).map((a, i) => (
                <div key={i} className="track-activity-row">
                  <span className="track-activity-actor">{a.actor}</span>{' '}
                  {a.field === 'created' ? 'created this' : `changed ${a.field}${a.to ? ` → ${a.to}` : ''}`}
                </div>
              ))}
            </div>
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return <div className="track-field"><span className="track-field-label">{label}</span><span className="track-field-val">{children}</span></div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return <section className="track-detail-section"><div className="track-detail-section-title">{title}</div>{children}</section>;
}
