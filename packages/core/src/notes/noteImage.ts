/**
 * ADR-029 D3 + F3 — pulling a remote picture INTO the store.
 *
 * The reference model — what `attachment:<id>` means and how a block's text is
 * read — is `noteImageRef.ts`, which is pure and therefore on the browser-safe
 * barrel: a renderer decides what to draw per render and cannot afford an IPC
 * round trip to find out whether its own text is a reference. This file is the
 * half that reaches the network, so it stays on the `notes` barrel.
 *
 * Re-exported from here as well, so a host handler that needs both imports one
 * path and the two halves cannot be given different answers.
 */
export * from './noteImageRef.js';

import { fetchGuardedBytes } from '../net/guardedFetch.js';

/** Big enough for a screenshot, small enough that one paste cannot wedge the host. */
export const MAX_NOTE_IMAGE_BYTES = 12 * 1024 * 1024;
export const NOTE_IMAGE_FETCH_TIMEOUT_MS = 15_000;

export type FetchedNoteImage =
  | { ok: true; name: string; mimeType: string; bytes: Buffer }
  | { ok: false; detail: string };

/**
 * Pull a remote picture into bytes the attachment store can keep.
 *
 * Through the SAME guard the bookmark preview and `fetch_url` use: an address
 * typed into a note is not a safer address than one typed into a tool call, and
 * a second fetch path here would be the one that forgets a range.
 */
export async function fetchNoteImage(
  rawUrl: string,
  opts: { userAgent: string; timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<FetchedNoteImage> {
  const res = await fetchGuardedBytes(String(rawUrl ?? '').trim(), {
    timeoutMs: opts.timeoutMs ?? NOTE_IMAGE_FETCH_TIMEOUT_MS,
    maxBytes: MAX_NOTE_IMAGE_BYTES,
    userAgent: opts.userAgent,
    accept: 'image/*',
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!res.ok) return { ok: false, detail: res.error };

  const mimeType = res.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) {
    // A host that answers its 404 page with a 200 is the common case here, and
    // storing that HTML as "the image" would produce a note holding a picture
    // that can never be drawn.
    return { ok: false, detail: 'That address did not answer with a picture.' };
  }

  return { ok: true, name: noteImageFileName(res.url, mimeType), mimeType, bytes: res.bytes };
}

/**
 * A file name for a fetched picture.
 *
 * From the URL's last segment when it looks like a file, because that is the
 * name the person would recognise; otherwise from the type, because a name is
 * what the attachment list shows and "file" tells a reader nothing.
 */
export function noteImageFileName(url: string, mimeType: string): string {
  const extension = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'img';
  let last = '';
  try {
    last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    last = '';
  }
  const cleaned = last.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  if (cleaned && /\.[A-Za-z0-9]{1,8}$/.test(cleaned)) return cleaned;
  return cleaned ? `${cleaned}.${extension}` : `image.${extension}`;
}
