/**
 * ADR-029 F3 — the bookmark block, which used to be a line of text.
 *
 * A card with the page's own title, description and icon, fetched now rather
 * than stored on the block: A3's argument about live references applies to a web
 * page as much as to a planner item, and a title cached into the note is the
 * snapshot that goes quietly wrong when the page is rewritten.
 *
 * **The failure path is the feature.** Every state below still draws the address
 * as something clickable, because a preview that cannot be fetched is still a
 * working link — and an empty card is precisely the offer-that-does-nothing F1
 * was written to remove. The wording lives in `bookmarkView.ts` so each failure
 * gets the sentence its next action deserves.
 *
 * The icon arrives as a `data:` URI from the host. It has to: the renderer's
 * content policy is `img-src 'self' data:`, so an `https://` favicon would draw
 * as the broken glyph this whole part exists to stop showing.
 */
import React, { useEffect, useState } from 'react';
import { Icon } from '../icons.js';
import { TextField } from './IconPicker.js';
import {
  bookmarkMonogram, bookmarkState, bookmarkUrl,
  type BookmarkAnswer,
} from '../lib/notes/bookmarkView.js';

export interface BookmarkBlockOps {
  /** The preview, fetched host-side through the shared guarded fetch. */
  previewBookmark: (url: string) => Promise<BookmarkAnswer | null>;
  /** The address is the block's own text — one field, so nothing can disagree. */
  setText: (id: string, text: string) => void;
  /**
   * Following the link is the shell's job; a note cannot open a window.
   *
   * It answers with the REASON when it refuses rather than returning void: the
   * shell's opener is https-only, and a card that swallowed that would be a
   * button doing nothing — the same defect one size down from the block itself.
   */
  openExternal: (url: string) => Promise<string | null>;
}

export function BookmarkBlock({ blockId, text, readOnly, ops }: {
  blockId: string;
  text: string;
  readOnly: boolean;
  ops: BookmarkBlockOps;
}): React.ReactElement {
  const [answer, setAnswer] = useState<BookmarkAnswer | null>(null);
  const [editing, setEditing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const url = bookmarkUrl(text);
  const state = bookmarkState(text, answer);

  // Keyed on the ADDRESS: changing it must clear the previous card rather than
  // leave the old site's title over the new link for a beat.
  useEffect(() => {
    setAnswer(null);
    setRefusal(null);
    if (!url) return;
    let cancelled = false;
    void ops.previewBookmark(url).then((next) => {
      if (cancelled) return;
      setAnswer(next ?? {
        ok: false,
        failure: { url, host: '', reason: 'unreachable', detail: '' },
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (state.state === 'empty' || editing || state.state === 'not-a-link') {
    return (
      <div className="notes-bookmark is-empty">
        {state.state === 'not-a-link' ? (
          <div className="notes-bookmark-note">{state.note}</div>
        ) : null}
        {readOnly ? (
          <span className="notes-bookmark-note">Another device is editing this block.</span>
        ) : (
          <TextField
            label="Web address" value={state.state === 'not-a-link' ? state.text : ''} placeholder="https://…"
            onSubmit={(value) => { ops.setText(blockId, value); setEditing(false); }}
          />
        )}
      </div>
    );
  }

  const host = state.state === 'ready' ? state.preview.host : state.host;
  const title = state.state === 'ready' ? state.preview.title : state.title;
  const target = state.state === 'ready' ? state.preview.url : state.url;

  return (
    <div className="notes-bookmark">
      <button
        className="notes-bookmark-card"
        title={target}
        onClick={() => {
          setRefusal(null);
          void ops.openExternal(target).then(setRefusal);
        }}
      >
        <span className="notes-bookmark-body">
          <span className="notes-bookmark-title">{title}</span>
          {state.state === 'ready' && state.preview.description ? (
            <span className="notes-bookmark-desc">{state.preview.description}</span>
          ) : null}
          {/* Every state ends here: the address, always. */}
          <span className="notes-bookmark-host">
            {host || target}
            {state.state === 'loading' ? ' · reading it…' : ''}
          </span>
        </span>
        <span className="notes-bookmark-icon" aria-hidden>
          {state.state === 'ready' && state.preview.iconDataUri ? (
            <img src={state.preview.iconDataUri} alt="" className="notes-bookmark-favicon" />
          ) : (
            // A letter rather than a generic glyph: a page of bookmarks all
            // showing the same mark is a page with no way to tell them apart,
            // which is the only thing an icon is for.
            <span className="notes-bookmark-monogram">{bookmarkMonogram(host || target)}</span>
          )}
        </span>
      </button>

      {state.state === 'link-only' ? <div className="notes-bookmark-note">{state.note}</div> : null}
      {/* A press that could not open anything says so. Silence here would be the
          same shape of defect as the block used to be, one control down. */}
      {refusal ? <div className="notes-bookmark-note">{refusal}</div> : null}

      {readOnly ? null : (
        <div className="notes-bookmark-tools">
          <button className="notes-bookmark-btn" onClick={() => setEditing(true)}>
            <Icon name="edit" size={11} /> Change the address
          </button>
        </div>
      )}
    </div>
  );
}
