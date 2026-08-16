/**
 * ADR-034 — browser-safe deterministic session-title fallback policy.
 *
 * This leaf owns the title shown before an Agent proposal exists so Core and
 * browser hosts cannot drift. It has no I/O, provider, crypto, or app imports;
 * titles are bounded display metadata and never routing identity.
 */

/** Upper bound on a stored title, including any final ellipsis. */
export const MAX_SESSION_TITLE = 60;

/** What every surface calls a session with no usable user prose. */
export const UNTITLED_SESSION = 'Untitled session';

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string): string {
  if (value.length <= MAX_SESSION_TITLE) return value;
  let cut = value.slice(0, MAX_SESSION_TITLE - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_SESSION_TITLE * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Derive a display fallback from the first user message.
 *
 * Fenced and inline code are removed, a useful first sentence is preferred,
 * and the result stays within the shared JavaScript string-length bound.
 */
export function deriveSessionTitle(firstUserMessage: string | null | undefined): string {
  if (typeof firstUserMessage !== 'string') return UNTITLED_SESSION;

  const withoutCode = firstUserMessage
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ');
  const prose = collapse(withoutCode);
  if (!prose) return UNTITLED_SESSION;

  const sentence = prose.match(/^[^.!?]{8,}?[.!?](?:\s|$)/)?.[0]?.trim();
  const candidate = sentence && sentence.length <= MAX_SESSION_TITLE * 1.5
    ? sentence.replace(/[.!?]+$/, '')
    : prose;
  return truncate(candidate) || UNTITLED_SESSION;
}
