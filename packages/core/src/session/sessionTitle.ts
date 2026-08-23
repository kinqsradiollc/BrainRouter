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

import {
  deriveSessionTitle,
  MAX_SESSION_TITLE,
  UNTITLED_SESSION,
} from '@kinqs/brainrouter-types/session-title';

export {
  deriveSessionTitle,
  MAX_SESSION_TITLE,
  UNTITLED_SESSION,
} from '@kinqs/brainrouter-types/session-title';

export type SessionTitleSource = 'derived' | 'agent' | 'hook' | 'human';

export interface ResolvedSessionTitle {
  title: string;
  source: SessionTitleSource;
}

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
  // The ellipsis is part of the persisted title and therefore part of the
  // shared JS string-length bound used by registry publication. Avoid cutting
  // between UTF-16 surrogate halves while reserving that final code unit.
  let cut = value.slice(0, MAX_SESSION_TITLE - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  // Prefer a word boundary so a title does not end mid-token.
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_SESSION_TITLE * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Human and hook titles may be concise, but still share the rendering bound. */
export function normalizeExplicitSessionTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || /\r?\n/.test(raw.trim())) return null;
  const cleaned = collapse(unwrap(raw));
  if (!cleaned || /^[#>*|]/.test(cleaned)) return null;
  return truncate(cleaned);
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

/** Resolve title and provenance with explicit authority precedence. */
export function resolveSessionTitleDecision(input: {
  humanTitle?: string | null;
  hookTitle?: string | null;
  agentTitle?: string | null;
  firstUserMessage?: string | null;
}): ResolvedSessionTitle {
  const human = normalizeExplicitSessionTitle(input.humanTitle);
  if (human) return { title: human, source: 'human' };
  const hook = normalizeExplicitSessionTitle(input.hookTitle);
  if (hook) return { title: hook, source: 'hook' };
  const agent = normalizeAgentTitle(input.agentTitle);
  if (agent) return { title: agent, source: 'agent' };
  return { title: deriveSessionTitle(input.firstUserMessage), source: 'derived' };
}
