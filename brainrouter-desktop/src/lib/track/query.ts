/**
 * TRACK QUERY — a small JQL-style query language for filtering work items.
 *
 * Grammar (case-insensitive keywords/fields):
 *   query   := or
 *   or      := and ( "OR" and )*
 *   and     := clause ( "AND" clause )*
 *   clause  := "(" or ")" | field op value | field "in" "(" value ("," value)* ")"
 *   op      := "=" | "!=" | "~" | ">" | "<" | ">=" | "<="
 *
 * Fields: status · category · type · priority · assignee · reporter · sprint ·
 * epic · label(s) · key · title · text. Values may be bare words or quoted.
 * Examples:
 *   status = done AND priority >= high
 *   type in (bug, story) AND assignee = ann
 *   text ~ reranker OR label = memory
 *
 * Pure + dependency-free; returns a predicate (or a structured parse error) so
 * callers — the store, the desktop filter, the `/track` CLI — never crash on a
 * bad query.
 */
import type { WorkItem } from '@kinqs/brainrouter-types';

const PRIORITY_ORDER: Record<string, number> = { lowest: 0, low: 1, medium: 2, high: 3, highest: 4 };
const COMPARATORS = new Set(['=', '!=', '~', '>', '<', '>=', '<=']);

export type WorkItemPredicate = (w: WorkItem) => boolean;
export interface QueryParse { ok: boolean; pred?: WorkItemPredicate; error?: string }

const KNOWN_FIELDS = new Set(['status', 'category', 'statuscategory', 'type', 'priority', 'assignee', 'reporter', 'sprint', 'sprintid', 'epic', 'epicid', 'label', 'labels', 'key', 'title', 'text']);

interface Token { kind: 'word' | 'op' | 'and' | 'or' | 'in' | 'lp' | 'rp' | 'comma'; value: string }

function tokenize(q: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { tokens.push({ kind: 'lp', value: '(' }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rp', value: ')' }); i++; continue; }
    if (c === ',') { tokens.push({ kind: 'comma', value: ',' }); i++; continue; }
    // two-char comparators first
    const two = q.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '!=') { tokens.push({ kind: 'op', value: two }); i += 2; continue; }
    if (c === '=' || c === '>' || c === '<' || c === '~') { tokens.push({ kind: 'op', value: c }); i++; continue; }
    if (c === '"' || c === "'") {
      const end = q.indexOf(c, i + 1);
      if (end < 0) { tokens.push({ kind: 'word', value: q.slice(i + 1) }); break; }
      tokens.push({ kind: 'word', value: q.slice(i + 1, end) }); i = end + 1; continue;
    }
    // bare word
    let j = i;
    while (j < q.length && !/[\s(),=<>!~'"]/.test(q[j])) j++;
    if (j === i) { i++; continue; } // unhandled stop-char (e.g. a lone "!"): skip it, never spin
    const w = q.slice(i, j);
    const lw = w.toLowerCase();
    if (lw === 'and') tokens.push({ kind: 'and', value: 'AND' });
    else if (lw === 'or') tokens.push({ kind: 'or', value: 'OR' });
    else if (lw === 'in') tokens.push({ kind: 'in', value: 'in' });
    else tokens.push({ kind: 'word', value: w });
    i = j;
  }
  return tokens;
}

function fieldValue(w: WorkItem, field: string): string | string[] | undefined {
  switch (field.toLowerCase()) {
    case 'status': return w.status;
    case 'category': case 'statuscategory': return w.statusCategory;
    case 'type': return w.type;
    case 'priority': return w.priority;
    case 'assignee': return w.assignee;
    case 'reporter': return w.reporter;
    case 'sprint': case 'sprintid': return w.sprintId;
    case 'epic': case 'epicid': return w.epicId;
    case 'label': case 'labels': return w.labels;
    case 'key': return w.key;
    case 'title': return w.title;
    case 'text': return `${w.key} ${w.title} ${w.description ?? ''}`;
    default: return undefined;
  }
}

function cmp(field: string, op: string, target: string, w: WorkItem): boolean {
  const actual = fieldValue(w, field);
  const t = target.toLowerCase();
  if (Array.isArray(actual)) {
    const has = actual.some((x) => x.toLowerCase() === t);
    return op === '!=' ? !has : op === '~' ? actual.some((x) => x.toLowerCase().includes(t)) : has;
  }
  const a = (actual ?? '').toString().toLowerCase();
  switch (op) {
    case '=': return a === t;
    case '!=': return a !== t;
    case '~': return a.includes(t);
    case '>': case '<': case '>=': case '<=': {
      // priority compares by rank; everything else lexicographically
      const ra = field.toLowerCase() === 'priority' ? PRIORITY_ORDER[a] : undefined;
      const rt = field.toLowerCase() === 'priority' ? PRIORITY_ORDER[t] : undefined;
      const [x, y] = ra !== undefined && rt !== undefined ? [ra, rt] : [a, t];
      if (op === '>') return x > y; if (op === '<') return x < y; if (op === '>=') return x >= y; return x <= y;
    }
    default: return false;
  }
}

/** Parse a query string into a predicate. Returns `{ ok:false, error }` on a bad query. */
export function parseTrackQuery(query: string): QueryParse {
  const tokens = tokenize(query);
  if (tokens.length === 0) return { ok: true, pred: () => true };
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const eat = (): Token => tokens[pos++];

  function parseOr(): WorkItemPredicate {
    let left = parseAnd();
    while (peek()?.kind === 'or') { eat(); const right = parseAnd(); const l = left; left = (w) => l(w) || right(w); }
    return left;
  }
  function parseAnd(): WorkItemPredicate {
    let left = parseClause();
    while (peek()?.kind === 'and') { eat(); const right = parseClause(); const l = left; left = (w) => l(w) && right(w); }
    return left;
  }
  function parseClause(): WorkItemPredicate {
    const tk = peek();
    if (!tk) throw new Error('unexpected end of query');
    if (tk.kind === 'lp') {
      eat();
      const inner = parseOr();
      if (peek()?.kind !== 'rp') throw new Error('expected ")"');
      eat();
      return inner;
    }
    if (tk.kind !== 'word') throw new Error(`expected a field, got "${tk.value}"`);
    const field = eat().value;
    if (!KNOWN_FIELDS.has(field.toLowerCase())) throw new Error(`unknown field "${field}"`);
    const next = peek();
    if (next?.kind === 'in') {
      eat();
      if (peek()?.kind !== 'lp') throw new Error('expected "(" after in');
      eat();
      const values: string[] = [];
      while (peek() && peek()!.kind !== 'rp') {
        if (peek()!.kind === 'word') values.push(eat().value);
        else if (peek()!.kind === 'comma') eat();
        else throw new Error(`unexpected "${peek()!.value}" in list`);
      }
      if (peek()?.kind !== 'rp') throw new Error('expected ")" to close list');
      eat();
      return (w) => values.some((v) => cmp(field, '=', v, w));
    }
    if (next?.kind === 'op') {
      const op = eat().value;
      const valTok = peek();
      if (!valTok || valTok.kind !== 'word') throw new Error(`expected a value after "${op}"`);
      const val = eat().value;
      return (w) => cmp(field, op, val, w);
    }
    throw new Error(`expected an operator after "${field}"`);
  }

  try {
    const pred = parseOr();
    if (pos < tokens.length) return { ok: false, error: `unexpected "${tokens[pos].value}"` };
    return { ok: true, pred };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Convenience: does a work item match the query? (a bad query matches nothing). */
export function matchesTrackQuery(w: WorkItem, query: string): boolean {
  const parsed = parseTrackQuery(query);
  return parsed.ok ? parsed.pred!(w) : false;
}

export const TRACK_QUERY_FIELDS = ['status', 'category', 'type', 'priority', 'assignee', 'reporter', 'sprint', 'epic', 'label', 'key', 'title', 'text'] as const;
export { COMPARATORS };
