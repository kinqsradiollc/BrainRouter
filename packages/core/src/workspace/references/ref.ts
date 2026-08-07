/**
 * ADR-029 A1 — one address space, and the parser that guards its door.
 *
 * `brainrouter://<mode>/<kind>/<id>` with an optional `#fragment`. It is a
 * string rather than an object reference for the reason Q5 gives: the desktop,
 * the dashboard and the CLI are three processes, and an in-process handle
 * cannot cross that boundary while a string can.
 *
 * **Parsing rejects; it never partially succeeds.** A reference is embedded in
 * a person's note and read back months later. A parser that returned
 * `{mode: 'planner', kind: '', id: ''}` for a truncated URI would hand that
 * husk to the registry, which would look for a mode that resolves kind `''`,
 * find none, and report the target missing — telling the reader their task was
 * deleted when in fact their link was mistyped. A3's whole argument is that a
 * document which is quietly wrong is worse than one that is obviously empty, so
 * the failure is named at the earliest point that knows what went wrong.
 *
 * **`mode` is a string, not a closed union.** Three clients ship on their own
 * schedules; a desktop build that predates a new mode will meet that mode's
 * URIs in synced content. Typing the union closed would make those *malformed*,
 * which is a lie about a well-formed reference. They parse, and resolution
 * reports them unavailable-here instead — see `resolution.ts`.
 */

export const WORKSPACE_REF_SCHEME = 'brainrouter://';

/**
 * A cap, because references live inside note content that syncs, is indexed,
 * and can reach an agent's context. Nothing legitimate is close to this; the
 * limit exists so a pathological string is refused at parse rather than
 * propagated into four subsystems that each assumed someone else bounded it.
 */
export const MAX_WORKSPACE_REF_LENGTH = 2048;

/** Ids carry file paths, so they are the long part; the rest is a slug. */
const MAX_ID_LENGTH = 512;
const MAX_FRAGMENT_LENGTH = 64;

/** `mode` and `kind` are vocabulary, not data: lowercase slugs, always. */
const SLUG = /^[a-z][a-z0-9-]{0,31}$/;

/** `#L59`, `#block-3`. No whitespace, no nesting, no second `#`. */
const FRAGMENT = /^[A-Za-z0-9._~:@!$&'()*+,;=/-]+$/;

export interface WorkspaceRef {
  /** Which surface owns the thing: `planner`, `notes`, `code`, … */
  readonly mode: string;
  /** What sort of thing within that surface: `item`, `block`, `file`, … */
  readonly kind: string;
  /**
   * The mode's own identifier. May contain `/` — a code file's id is its
   * workspace-relative path, and a chat turn's is `<session>/<turn>`.
   */
  readonly id: string;
  /** A position inside the target: a line range, a heading. */
  readonly fragment?: string;
}

export type WorkspaceRefParseFailure =
  | 'not_a_string'
  | 'empty'
  | 'too_long'
  | 'wrong_scheme'
  | 'missing_mode'
  | 'invalid_mode'
  | 'missing_kind'
  | 'invalid_kind'
  | 'missing_id'
  | 'invalid_id'
  | 'invalid_fragment';

export type WorkspaceRefParse =
  | { readonly ok: true; readonly ref: WorkspaceRef }
  | { readonly ok: false; readonly reason: WorkspaceRefParseFailure; readonly detail: string };

function fail(reason: WorkspaceRefParseFailure, detail: string): WorkspaceRefParse {
  return { ok: false, reason, detail };
}

/**
 * Parse a reference, or say precisely why it is not one.
 *
 * Takes `unknown` deliberately: the callers are content parsers and IPC
 * boundaries where the value has not been checked, and an `unknown` parameter
 * is how the check stops being someone else's job.
 */
export function parseWorkspaceRef(input: unknown): WorkspaceRefParse {
  if (typeof input !== 'string') return fail('not_a_string', `expected a string, received ${typeof input}`);

  const raw = input.trim();
  if (raw.length === 0) return fail('empty', 'the reference is blank');
  if (raw.length > MAX_WORKSPACE_REF_LENGTH) {
    return fail('too_long', `${raw.length} characters exceeds the ${MAX_WORKSPACE_REF_LENGTH} limit`);
  }
  if (raw.slice(0, WORKSPACE_REF_SCHEME.length).toLowerCase() !== WORKSPACE_REF_SCHEME) {
    return fail('wrong_scheme', `expected ${WORKSPACE_REF_SCHEME}`);
  }

  let rest = raw.slice(WORKSPACE_REF_SCHEME.length);

  let fragment: string | undefined;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    const tail = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
    if (tail.length === 0) return fail('invalid_fragment', 'a `#` with nothing after it');
    if (tail.length > MAX_FRAGMENT_LENGTH) return fail('invalid_fragment', 'fragment is too long');
    if (!FRAGMENT.test(tail)) return fail('invalid_fragment', `not a fragment: ${tail}`);
    fragment = tail;
  }

  // A query string would give the same target two spellings, and the backlink
  // index keys on the spelling.
  if (rest.includes('?')) return fail('invalid_id', 'query strings are not part of this scheme');

  const modeEnd = rest.indexOf('/');
  if (rest.length === 0) return fail('missing_mode', 'nothing after the scheme');
  if (modeEnd === 0) return fail('missing_mode', 'the mode segment is empty');
  if (modeEnd < 0) return fail('missing_kind', `\`${rest}\` has a mode but no kind`);
  const mode = rest.slice(0, modeEnd);
  if (!SLUG.test(mode)) return fail('invalid_mode', `\`${mode}\` is not a lowercase slug`);

  const afterMode = rest.slice(modeEnd + 1);
  const kindEnd = afterMode.indexOf('/');
  if (afterMode.length === 0) return fail('missing_kind', 'the kind segment is empty');
  if (kindEnd === 0) return fail('missing_kind', 'the kind segment is empty');
  if (kindEnd < 0) return fail('missing_id', `\`${mode}/${afterMode}\` has a kind but no id`);
  const kind = afterMode.slice(0, kindEnd);
  if (!SLUG.test(kind)) return fail('invalid_kind', `\`${kind}\` is not a lowercase slug`);

  const rawId = afterMode.slice(kindEnd + 1);
  if (rawId.length === 0) return fail('missing_id', 'the id segment is empty');
  if (rawId.length > MAX_ID_LENGTH) return fail('invalid_id', `id exceeds ${MAX_ID_LENGTH} characters`);
  // Unencoded whitespace means the URI was pasted broken or was never one.
  if (/\s/.test(rawId)) return fail('invalid_id', 'unencoded whitespace in the id');

  const id = decodeId(rawId);
  if (id === null) return fail('invalid_id', 'malformed percent-escape in the id');
  // A control character survives JSON and reappears as a broken line in
  // whatever renders the label.
  if (/[\u0000-\u001f\u007f]/.test(id)) return fail('invalid_id', 'control character in the id');

  return { ok: true, ref: fragment === undefined ? { mode, kind, id } : { mode, kind, id, fragment } };
}

/** The canonical spelling, including the fragment. Round-trips through `parseWorkspaceRef`. */
export function formatWorkspaceRef(ref: WorkspaceRef): string {
  const base = `${WORKSPACE_REF_SCHEME}${ref.mode}/${ref.kind}/${encodeId(ref.id)}`;
  return ref.fragment ? `${base}#${ref.fragment}` : base;
}

/**
 * The key a reference is indexed under — the target WITHOUT its fragment.
 *
 * A note citing `code/file/parser.ts#L59` and one citing `#L12` both link to
 * the same file, and "what links here" that split them by line number would
 * answer a question nobody asked. The fragment is kept on the edge instead
 * (see `backlinks.ts`), so nothing is lost by not keying on it.
 */
export function workspaceRefKey(ref: WorkspaceRef): string {
  return `${WORKSPACE_REF_SCHEME}${ref.mode}/${ref.kind}/${encodeId(ref.id)}`;
}

/** Same target and same position. Use `workspaceRefKey` when position is irrelevant. */
export function workspaceRefEquals(a: WorkspaceRef, b: WorkspaceRef): boolean {
  return a.mode === b.mode && a.kind === b.kind && a.id === b.id && (a.fragment ?? '') === (b.fragment ?? '');
}

export function isWorkspaceRefString(value: unknown): boolean {
  return parseWorkspaceRef(value).ok;
}

/* --------------------------------------------------------------- escaping */

/**
 * Percent-encode only what would otherwise change the parse.
 *
 * `/` is left literal because ids legitimately contain it and encoding it would
 * make every file reference unreadable to the person who has to eyeball it in a
 * note.
 */
function encodeId(id: string): string {
  let out = '';
  for (const ch of id) {
    const code = ch.codePointAt(0)!;
    if (ch === '%' || ch === '#' || ch === '?' || code <= 0x20 || code === 0x7f) {
      for (const byte of new TextEncoder().encode(ch)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/** Returns null rather than throwing: a bad escape is a parse failure with a reason. */
function decodeId(raw: string): string | null {
  if (!raw.includes('%')) return raw;
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch !== '%') {
      for (const byte of new TextEncoder().encode(ch)) bytes.push(byte);
      continue;
    }
    const hex = raw.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
    bytes.push(Number.parseInt(hex, 16));
    i += 2;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}
