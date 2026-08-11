/**
 * ADR-029 D3 + F3 — the image block, which used to be an empty paragraph.
 *
 * Two ways in, because those are the two gestures people actually use: a file
 * picker, and ⌘V with a screenshot on the clipboard. Both end in the SAME place
 * — `ingestAttachment` through the host — because D3 says an image pasted into
 * three notes is one object with three references, and two intake paths writing
 * two stores is how that stops being true.
 *
 * The block holds `attachment:<id>`; the bytes are the attachment store's. What
 * is drawn while there are none is the whole point of `imageView.ts`: four
 * different reasons a picture is not on screen, each said in a sentence, and
 * never the browser's broken-image glyph.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import {
  IMAGE_EMPTY_INVITATION, imageState, notAPictureNote,
  type NoteImageDto,
} from './imageView.js';
import type { NotesImageCapability } from './capabilities.js';

export interface ImageBlockOps {
  /** Absent when this host has no attachment-byte transport. */
  images?: NotesImageCapability;
  /** Clearing the reference is an ordinary text write — the block stays an image. */
  setText: (id: string, text: string) => void;
}

export function ImageBlock({ blockId, text, readOnly, ops }: {
  blockId: string;
  text: string;
  /** B2 — another device holds this block, so it cannot be replaced from here. */
  readOnly: boolean;
  ops: ImageBlockOps;
}): React.ReactElement {
  const [answer, setAnswer] = useState<NoteImageDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const state = imageState(text, answer);

  // The read is keyed on the reference rather than on the block: replacing the
  // picture must not leave the previous one on screen, and a stale `answer` with
  // the old id is exactly what `imageState` treats as "still loading".
  useEffect(() => {
    if (state.state !== 'loading') return;
    if (!ops.images) {
      setAnswer({ id: state.id, name: '', error: 'this host cannot read stored image bytes.' });
      return;
    }
    let cancelled = false;
    void ops.images.read(state.id).then((dto) => {
      if (cancelled) return;
      // A host that could not answer at all is reported as a record with a
      // reason rather than left loading forever — a spinner that never resolves
      // is the silent failure this block exists to stop having.
      setAnswer(dto ?? { id: state.id, name: '', error: 'it could not be read from here.' });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.state === 'loading' ? state.id : null]);

  const store = useCallback(async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) {
      setProblem(notAPictureNote(file.name, file.type));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const buffer = await file.arrayBuffer();
      // Chunked, because `String.fromCharCode(...bytes)` on a multi-megabyte
      // screenshot blows the argument limit and throws — which would look to the
      // person like a paste that silently did nothing.
      if (!ops.images) return;
      const error = await ops.images.attach(blockId, { name: file.name || 'pasted.png', dataBase64: toBase64(buffer) });
      if (error) setProblem(error);
      else setAnswer(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'That picture could not be read.');
    } finally {
      setBusy(false);
    }
  }, [blockId, ops]);

  return (
    <div
      className="notes-image"
      // The paste is caught on the block rather than on the document, so a
      // screenshot lands in the image someone is looking at and not in whichever
      // one was focused last.
      onPaste={(event) => {
        if (readOnly || !ops.images) return;
        const file = [...event.clipboardData.files].find((entry) => entry.type.startsWith('image/'));
        if (!file) return;
        event.preventDefault();
        void store(file);
      }}
      onDragOver={(event) => { if (!readOnly && ops.images && event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={(event) => {
        if (readOnly || !ops.images) return;
        const file = [...event.dataTransfer.files][0];
        if (!file) return;
        event.preventDefault();
        void store(file);
      }}
      tabIndex={0}
    >
      {state.state === 'ready' ? (
        <figure className="notes-image-figure">
          <img src={state.src} alt={state.alt} className="notes-image-img" />
          <figcaption className="notes-image-caption">{state.alt}</figcaption>
        </figure>
      ) : null}

      {state.state === 'loading' ? (
        <div className="notes-image-frame"><span className="notes-image-note">Reading the picture…</span></div>
      ) : null}

      {state.state === 'empty' ? (
        <div className="notes-image-frame">
          <span className="notes-image-note">{IMAGE_EMPTY_INVITATION}</span>
        </div>
      ) : null}

      {/* Every non-ready state says WHY in a sentence. This is the requirement
          the block was rebuilt for: a grey square tells a reader something is
          wrong and nothing about what to do next. */}
      {state.state === 'missing' || state.state === 'unusable' ? (
        <div className="notes-image-frame">
          <Icon name="warn" size={12} />
          <span className="notes-image-note">{state.note}</span>
        </div>
      ) : null}

      {state.state === 'remote' ? (
        <div className="notes-image-frame">
          <span className="notes-image-note">{state.note}</span>
          <span className="notes-image-url" title={state.url}>{state.url}</span>
          {readOnly || !ops.images ? null : (
            <button
              className="notes-image-btn"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setProblem(null);
                void ops.images!.storeRemote(blockId, state.url)
                  .then((error) => { if (error) setProblem(error); else setAnswer(null); })
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? 'Fetching it…' : 'Store it with this note'}
            </button>
          )}
        </div>
      ) : null}

      {readOnly || !ops.images ? null : (
        <div className="notes-image-tools">
          <input
            ref={fileInput} type="file" accept="image/*" hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared before the async work, so choosing the SAME file twice
              // still fires a change event the second time.
              event.target.value = '';
              if (file) void store(file);
            }}
          />
          <button className="notes-image-btn" disabled={busy} onClick={() => fileInput.current?.click()}>
            <Icon name="plus" size={11} /> {state.state === 'ready' ? 'Replace' : 'Choose a file'}
          </button>
          {state.state === 'ready' || state.state === 'missing' ? (
            <button className="notes-image-btn" onClick={() => { ops.setText(blockId, ''); setAnswer(null); }}>
              Remove
            </button>
          ) : null}
          <span className="notes-image-hint">or paste one straight in</span>
        </div>
      )}

      {!readOnly && !ops.images ? (
        <div className="notes-image-hint">This host cannot attach or read image files.</div>
      ) : null}

      {problem ? <div className="notes-image-problem">{problem}</div> : null}
      {busy && state.state !== 'remote' ? <div className="notes-image-problem">Storing it…</div> : null}
    </div>
  );
}

/**
 * Bytes to base64, in chunks.
 *
 * `fromCharCode(...bytes)` on a whole screenshot exceeds the argument limit and
 * throws, which the person experiences as a paste that did nothing at all.
 */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}
