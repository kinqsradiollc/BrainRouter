/**
 * ADR-027 D8 (P5-2) — naming a session.
 *
 * Today both surfaces truncate the first user message, and inconsistently: the
 * dashboard cuts at 52 characters and falls back to "Untitled task", the
 * desktop cuts at 48 and says "New session". Truncation is a poor name because
 * the first thing someone types is usually the *situation*, not the *task* —
 * "hey, the build is broken again after that merge, can you look" truncates to
 * noise, while the session is really "Fix post-merge build failure".
 *
 * So the agent proposes a title on turn 1 and it wins when it is usable. The
 * derived fallback stays, because a title must always exist and the agent may
 * not have answered yet on the very first render.
 *
 * The validation here is the load-bearing part. A model asked for a title will
 * sometimes return a refusal, a preamble, a quoted restatement, or an essay,
 * and any of those pasted into a session list is worse than an honest
 * truncation.
 */

/** Upper bound on a stored title. Long enough to be specific, short enough to render. */
export const MAX_SESSION_TITLE = 60;

/** What we call a session with nothing to go on yet. */
export const UNTITLED_SESSION = 'Untitled session';

/**
 * Phrases that mean the model answered the wrong question. A title beginning
 * with any of these is a preamble or a refusal, not a name.
 */
const NON_TITLE_PREFIXES = [
  'here is',
  'here are',
  "here's",
  'sure',
  'certainly',
  'of course',
  'i can',
  'i will',
  "i'll",
  'the title',
  'title:',
  'session title',
  'as an ai',
  'i cannot',
  "i can't",
  'sorry',
];

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Strip wrapping quotes/backticks a model adds around a title it was asked for. */
function unwrap(value: string): string {
  let out = value.trim();
  for (let i = 0; i < 2; i++) {
    const first = out[0];
    const last = out[out.length - 1];
    if (out.length > 1 && first === last && (first === '"' || first === "'" || first === '`')) {
      out = out.slice(1, -1).trim();
    }
  }
  return out;
}

function truncate(value: string): string {
  if (value.length <= MAX_SESSION_TITLE) return value;
  // Prefer a word boundary so a title does not end mid-token.
  const cut = value.slice(0, MAX_SESSION_TITLE);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_SESSION_TITLE * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Validate a title the agent proposed. Returns null when it is unusable, so the
 * caller falls back rather than storing something embarrassing.
 */
export function normalizeAgentTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // A multi-line answer is prose, not a title — take nothing rather than guess
  // which line was meant.
  if (/\r?\n/.test(raw.trim())) return null;

  const cleaned = collapse(unwrap(raw));
  if (!cleaned) return null;
  // Two words minimum: a bare "Fix" or "Bug" names nothing.
  if (cleaned.length < 3 || !/\s/.test(cleaned)) return null;
  // Markdown, code, or JSON leaked through — the model answered structurally.
  if (/^[#>*\-|]/.test(cleaned) || cleaned.startsWith('{') || cleaned.startsWith('[')) return null;

  const lowered = cleaned.toLowerCase();
  if (NON_TITLE_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return null;
  // An answer far longer than a title is a paragraph.
  if (cleaned.length > MAX_SESSION_TITLE * 3) return null;

  return truncate(cleaned);
}

/**
 * Derive a fallback title from the first user message.
 *
 * Deliberately conservative: strip fenced code and markdown noise, keep the
 * first sentence, and truncate on a word boundary. It is a placeholder until
 * the agent proposes something better, so it should never look authoritative.
 */
export function deriveSessionTitle(firstUserMessage: string | null | undefined): string {
  if (typeof firstUserMessage !== 'string') return UNTITLED_SESSION;

  // A pasted stack trace or code block is not a name; drop fenced regions and
  // inline code before looking for prose.
  const withoutCode = firstUserMessage
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ');

  const prose = collapse(withoutCode);
  if (!prose) return UNTITLED_SESSION;

  // First sentence, when there is a clear one worth keeping.
  const sentence = prose.match(/^[^.!?]{8,}?[.!?](?:\s|$)/)?.[0]?.trim();
  const candidate = sentence && sentence.length <= MAX_SESSION_TITLE * 1.5
    ? sentence.replace(/[.!?]+$/, '')
    : prose;

  return truncate(candidate) || UNTITLED_SESSION;
}

/**
 * The single answer to "what is this session called?".
 *
 * Both surfaces call this so a session does not change name when the user
 * switches between the desktop and the dashboard.
 */
export function resolveSessionTitle(input: {
  agentTitle?: string | null;
  firstUserMessage?: string | null;
}): string {
  return normalizeAgentTitle(input.agentTitle) ?? deriveSessionTitle(input.firstUserMessage);
}
