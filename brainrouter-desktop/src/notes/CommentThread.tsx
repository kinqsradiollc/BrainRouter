/**
 * ADR-029 F3 — the comments on a block, resolved and unresolved.
 *
 * Markup over `lib/notes/commentThread`. Nothing about ordering, sectioning or
 * what the thread is called is decided here; a component that decided them would
 * decide them differently from the dashboard, and a thread that reads as a
 * different conversation on two screens is worse than one that is missing.
 *
 * The one thing this file owns is the DRAFT — the text in the composer before it
 * is posted — which is genuinely local: it is not content until somebody presses
 * the button, and stamping every keystroke into a synced record would put a
 * half-written thought on somebody else's screen.
 */
import React, { useState } from 'react';
import { Icon } from '../icons.js';
import {
  canPostComment, commentPlaceholder, commentSections, commentThreadTitle,
  resolveActionLabel, type NoteCommentDto,
} from '../lib/notes/commentThread.js';
import type { NotesOps } from './NotesMode.js';

export function CommentThread({ blockId, comments, ops, readOnly }: {
  blockId: string;
  comments: readonly NoteCommentDto[];
  ops: NotesOps;
  /** C5's case: the block is gone, so the thread is a record rather than a place to reply. */
  readOnly?: boolean;
}): React.ReactElement {
  const [draft, setDraft] = useState('');
  /** Which comment is being corrected, and what it currently reads. */
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const sections = commentSections(comments);

  const post = (): void => {
    if (!canPostComment(draft)) return;
    ops.addComment(blockId, draft.trim());
    setDraft('');
  };

  return (
    <div className="notes-comments">
      <div className="notes-comments-head">{commentThreadTitle(comments)}</div>

      {[...sections.open, ...sections.resolved].map((comment) => (
        <div
          key={comment.id}
          className={`notes-comment${comment.resolved ? ' is-resolved' : ''}`}
        >
          <div className="notes-comment-who">
            <span className="notes-comment-author">{comment.author}</span>
            {/* A resolved remark is KEPT and marked rather than hidden: "we
                decided not to" is often the most valuable sentence on a block,
                and a resolve that hid it would make people avoid resolving. */}
            {comment.resolved ? <span className="notes-comment-state">resolved</span> : null}
          </div>
          {/* A correction EDITS rather than deleting and reposting. Reposting
              would move the remark to the end of the thread, so the reply
              underneath it would stop making sense — and the edit merges as
              prose, keeping both versions if two devices correct it at once. */}
          {editing?.id === comment.id ? (
            <div className="notes-comment-composer">
              <textarea
                className="notes-comment-input"
                rows={2}
                autoFocus
                value={editing.body}
                onChange={(event) => setEditing({ id: comment.id, body: event.target.value })}
                onKeyDown={(event) => event.stopPropagation()}
              />
              <div className="notes-comment-actions" style={{ opacity: 1 }}>
                <button
                  disabled={!canPostComment(editing.body)}
                  onClick={() => { ops.editComment(blockId, comment.id, editing.body.trim()); setEditing(null); }}
                >
                  Save
                </button>
                <button onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <p className="notes-comment-body">{comment.body}</p>
          )}
          {readOnly || editing?.id === comment.id ? null : (
            <div className="notes-comment-actions">
              <button onClick={() => ops.setCommentResolved(blockId, comment.id, !comment.resolved)}>
                {resolveActionLabel(comment.resolved)}
              </button>
              <button onClick={() => setEditing({ id: comment.id, body: comment.body })}>Edit</button>
              <button onClick={() => ops.removeComment(blockId, comment.id)}>Delete</button>
            </div>
          )}
        </div>
      ))}

      {readOnly ? null : (
        <div className="notes-comment-composer">
          <textarea
            className="notes-comment-input"
            rows={2}
            value={draft}
            placeholder={commentPlaceholder(comments.length > 0)}
            onChange={(event) => setDraft(event.target.value)}
            // ⌘Enter posts. Plain Enter stays a newline, because a comment is
            // often two sentences and losing the second one to a reflex is the
            // kind of small betrayal that stops people commenting.
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                post();
              }
            }}
          />
          <button className="notes-comment-post" disabled={!canPostComment(draft)} onClick={post}>
            <Icon name="check-circle" size={11} /> Comment
          </button>
        </div>
      )}
    </div>
  );
}
