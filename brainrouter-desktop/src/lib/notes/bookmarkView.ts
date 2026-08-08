/**
 * ADR-029 F3 — what a bookmark shows, including when the fetch got nothing.
 *
 * The rule this file exists to enforce is one sentence from the task the block
 * was built for: **a preview that cannot be fetched is still a working link.**
 * So there is no state in which this renders an empty card. Every branch below
 * ends with an address a person can click, and the ones that failed also carry a
 * sentence saying what happened — because "nothing appeared" is the failure that
 * teaches someone the rest of the menu does not work either (F1).
 *
 * The preview itself is RESOLVED, never stored on the block (A3's argument, one
 * level down): the block holds the URL, and the title and description are read
 * now. A title cached into the note would be the snapshot that goes quietly
 * wrong when the page is rewritten.
 *
 * Pure — the fetch is a host handler, and this only says what to draw.
 */

/** `notes-bookmark-preview`'s answer, as it crosses the bridge. */
export interface BookmarkPreviewDto {
  url: string;
  host: string;
  title: string;
  description: string;
  iconDataUri?: string;
}

export interface BookmarkFailureDto {
  url: string;
  host: string;
  reason: string;
  detail: string;
}

export type BookmarkAnswer =
  | { ok: true; preview: BookmarkPreviewDto }
  | { ok: false; failure: BookmarkFailureDto };

export type BookmarkState =
  /** No address yet. An invitation, not a failure. */
  | { state: 'empty' }
  /** An address that is not one — nothing to fetch and nothing to open. */
  | { state: 'not-a-link'; text: string; note: string }
  /** The address is good and the answer has not arrived. */
  | { state: 'loading'; url: string; host: string; title: string }
  | { state: 'ready'; preview: BookmarkPreviewDto }
  /** Fetched and got nothing usable — the link still works. */
  | { state: 'link-only'; url: string; host: string; title: string; note: string };

/**
 * One sentence per failure, because the reader's next move differs.
 *
 * A blocked address will never work and saying "could not be reached" would send
 * someone to check their network. A page behind a login will work for them in a
 * browser, so the card should not imply the link is broken.
 */
export function bookmarkFailureNote(reason: string, detail?: string): string {
  switch (reason) {
    case 'blocked':
      return 'That address points inside this machine or its network, so it was not fetched.';
    case 'timeout':
      return 'The site did not answer in time. The link still works.';
    case 'oversized':
      return 'The page is too large to preview. The link still works.';
    case 'http_error':
      return `The site answered with an error${detail ? ` (${detail})` : ''}. The link still works.`;
    case 'not_a_page':
      return 'That address is a file rather than a page, so there is nothing to preview.';
    case 'not_a_url':
      return 'That is not a web address.';
    default:
      return 'No preview could be read. The link still works.';
  }
}

/** A web address, or null. The one place the block decides what its text is. */
export function bookmarkUrl(text: string): string | null {
  const value = (text ?? '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The host, for the line under the title and for the monogram. */
export function bookmarkHostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The letter shown when there is no icon.
 *
 * A letter rather than a generic globe, because a page of bookmarks all showing
 * the same glyph is a page with no way to tell them apart at a glance — which is
 * the only thing an icon is for.
 */
export function bookmarkMonogram(host: string): string {
  const first = (host ?? '').replace(/^www\./, '').trim().charAt(0);
  return first ? first.toUpperCase() : '·';
}

/** What the card draws, given the block's text and whatever the host answered. */
export function bookmarkState(text: string, answer: BookmarkAnswer | null): BookmarkState {
  const raw = (text ?? '').trim();
  if (!raw) return { state: 'empty' };

  const url = bookmarkUrl(raw);
  if (!url) {
    return {
      state: 'not-a-link',
      text: raw,
      note: 'A bookmark needs a web address. Paste one, or turn this line back into text.',
    };
  }

  const host = bookmarkHostOf(url);
  if (!answer) return { state: 'loading', url, host, title: host || url };

  if (answer.ok) {
    // A preview whose title came back empty still gets one: the host is always
    // available, and a card with a blank line where a title goes reads as the
    // fetch having half-worked.
    return {
      state: 'ready',
      preview: {
        ...answer.preview,
        title: answer.preview.title.trim() || answer.preview.host || url,
      },
    };
  }

  return {
    state: 'link-only',
    url: answer.failure.url || url,
    host: answer.failure.host || host,
    title: answer.failure.host || host || url,
    note: bookmarkFailureNote(answer.failure.reason, answer.failure.detail),
  };
}
