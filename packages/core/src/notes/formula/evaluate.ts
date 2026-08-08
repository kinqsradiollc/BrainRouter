/**
 * ADR-029 F2 — walking the tree, totally.
 *
 * The invariant this file exists to hold: **`evaluateNode` returns a
 * `FormulaValue` for every input, always.** No throw, no `undefined`, no `NaN`.
 * Every operator asks `firstError` before it does anything, so an error that
 * appears anywhere in an expression comes out of the top of it with its sentence
 * intact — which is what makes "a cell that cannot be computed says why" a
 * property of the engine rather than a thing each function remembers to do.
 *
 * **Property references are resolved by a callback, not by reaching for a row.**
 * The caller owns what a property means: `computed.ts` gives it the row's stored
 * cells and the other formulas of the same row, and it is the caller that
 * detects a cycle, because a cycle is a property of the SCHEMA and this file only
 * ever sees one expression.
 *
 * **Text results are capped.** `concat(x, x)` nested twenty deep is a million
 * characters from a formula somebody could paste into a shared database, so
 * every string-producing function goes through `text()`, which refuses past
 * `MAX_FORMULA_TEXT` with a typed error instead of returning the string. A
 * bounded parser with an unbounded evaluator is not bounded.
 */
import { datePropertyMs, normaliseDateValue } from '../properties.js';
import { MAX_FORMULA_TOKENS, type BinaryOp, type FormulaNode } from './parse.js';
import {
  asBoolean, asNumber, asText, bool, date, EMPTY, err, firstError, isError,
  num, text, typeName, MAX_FORMULA_TEXT,
  type FormulaValue,
} from './value.js';

export interface FormulaContext {
  /** The value of another property of the same row, already computed. */
  property: (name: string) => FormulaValue;
  /** `now()` and `today()`, supplied so a test is not a race against the clock. */
  nowMs: number;
}

const DAY_ONLY = (value: string): boolean => value.length === 10;

/* ------------------------------------------------------------- comparison */

/**
 * Order two values, or say they cannot be compared.
 *
 * Cross-type comparison is an ERROR rather than a coercion. `prop("Due") > 3`
 * has no answer, and every language that invents one — by stringifying, by
 * casting, by ordering types — produces a filter that quietly matches the wrong
 * rows. An error here is a sentence in one cell; a coercion is a wrong number in
 * all of them.
 */
function compareValues(a: FormulaValue, b: FormulaValue): number | FormulaValue {
  const error = firstError([a, b]);
  if (error) return error;
  if (a.kind === 'empty' || b.kind === 'empty') return EMPTY;
  if (a.kind === 'number' && b.kind === 'number') return a.value === b.value ? 0 : a.value < b.value ? -1 : 1;
  if (a.kind === 'text' && b.kind === 'text') return a.value === b.value ? 0 : a.value < b.value ? -1 : 1;
  if (a.kind === 'boolean' && b.kind === 'boolean') return (a.value ? 1 : 0) - (b.value ? 1 : 0);
  if (a.kind === 'date' && b.kind === 'date') {
    const x = datePropertyMs(a.value);
    const y = datePropertyMs(b.value);
    if (x === null || y === null) return err('type_mismatch', 'One of these dates cannot be read.');
    return x === y ? 0 : x < y ? -1 : 1;
  }
  return err('type_mismatch', `${typeName(a)} and ${typeName(b)} cannot be compared with each other.`);
}

function equals(a: FormulaValue, b: FormulaValue): FormulaValue {
  const error = firstError([a, b]);
  if (error) return error;
  // Two empty cells ARE equal, and an empty cell is not equal to a value. This
  // is the one place `empty` answers rather than absorbing: "has this been
  // filled in with the same thing" is a question with an answer even when the
  // answer is "neither has been filled in".
  if (a.kind === 'empty' || b.kind === 'empty') return bool(a.kind === b.kind);
  if (a.kind === 'list' || b.kind === 'list') {
    if (a.kind !== 'list' || b.kind !== 'list') return bool(false);
    return bool(a.value.length === b.value.length && a.value.every((entry, i) => entry === b.value[i]));
  }
  const order = compareValues(a, b);
  if (typeof order !== 'number') return order;
  return bool(order === 0);
}

/* --------------------------------------------------------------- operators */

function arithmetic(op: BinaryOp, left: FormulaValue, right: FormulaValue): FormulaValue {
  const error = firstError([left, right]);
  if (error) return error;

  // `+` over text concatenates, because a person who writes
  // `prop("First") + " " + prop("Last")` means exactly that and would be
  // surprised by an error. Every OTHER arithmetic operator refuses text — there
  // is no reading of `"a" * 2` that is not a guess.
  if (op === '+' && (left.kind === 'text' || right.kind === 'text')) {
    const a = asText(left);
    const b = asText(right);
    if (typeof a !== 'string') return a;
    if (typeof b !== 'string') return b;
    return text(a + b);
  }

  // An empty operand ABSORBS: a row nobody has filled in yet computes to empty
  // rather than to a number derived from a blank. See `value.ts`.
  if (left.kind === 'empty' || right.kind === 'empty') return EMPTY;

  const a = asNumber(left);
  if (typeof a !== 'number') return a;
  const b = asNumber(right);
  if (typeof b !== 'number') return b;

  switch (op) {
    case '+': return num(a + b);
    case '-': return num(a - b);
    case '*': return num(a * b);
    case '/':
      // F2 names this one specifically: a typed error with a sentence, not
      // `Infinity` and not `0`.
      return b === 0
        ? err('divide_by_zero', 'This divides by zero, which has no answer.')
        : num(a / b);
    case '%':
      return b === 0
        ? err('divide_by_zero', 'This takes a remainder after dividing by zero, which has no answer.')
        : num(a % b);
    case '^': return num(a ** b);
    default: return err('type_mismatch', `“${op}” is not an arithmetic operator.`);
  }
}

function evaluateBinary(node: Extract<FormulaNode, { t: 'binary' }>, ctx: FormulaContext, depth: number): FormulaValue {
  // `and` / `or` short-circuit, so `prop("Rate") != 0 and prop("Cost") /
  // prop("Rate") > 1` does not report a division by zero the person already
  // guarded against.
  if (node.op === 'and' || node.op === 'or') {
    const left = evaluateNode(node.left, ctx, depth + 1);
    const decided = asBoolean(left);
    if (typeof decided !== 'boolean') return decided;
    if (node.op === 'and' && !decided) return bool(false);
    if (node.op === 'or' && decided) return bool(true);
    const right = evaluateNode(node.right, ctx, depth + 1);
    const other = asBoolean(right);
    return typeof other === 'boolean' ? bool(other) : other;
  }

  const left = evaluateNode(node.left, ctx, depth + 1);
  const right = evaluateNode(node.right, ctx, depth + 1);

  if (node.op === '=' ) return equals(left, right);
  if (node.op === '!=') {
    const same = equals(left, right);
    return same.kind === 'boolean' ? bool(!same.value) : same;
  }
  if (node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') {
    const order = compareValues(left, right);
    if (typeof order !== 'number') return order;
    switch (node.op) {
      case '<': return bool(order < 0);
      case '<=': return bool(order <= 0);
      case '>': return bool(order > 0);
      default: return bool(order >= 0);
    }
  }
  return arithmetic(node.op, left, right);
}

/* --------------------------------------------------------------- functions */

export interface FormulaFunctionSpec {
  name: string;
  /** What a person picking it from a list needs to read. */
  summary: string;
  minArgs: number;
  /** `null` for "any number", which only the variadic aggregates use. */
  maxArgs: number | null;
}

/**
 * The catalogue, exported so an editor can list what exists.
 *
 * A function menu built from a second list would drift from this one, and the
 * drift shows up as a menu entry that evaluates to "there is no function called
 * …" — F1's defect, one layer in.
 */
export const FORMULA_FUNCTIONS: readonly FormulaFunctionSpec[] = [
  { name: 'if', summary: 'if(test, then, otherwise)', minArgs: 3, maxArgs: 3 },
  { name: 'empty', summary: 'empty(value) — is this cell blank?', minArgs: 1, maxArgs: 1 },
  { name: 'ifEmpty', summary: 'ifEmpty(value, fallback)', minArgs: 2, maxArgs: 2 },
  { name: 'not', summary: 'not(checkbox)', minArgs: 1, maxArgs: 1 },
  { name: 'abs', summary: 'abs(number)', minArgs: 1, maxArgs: 1 },
  { name: 'round', summary: 'round(number, places)', minArgs: 1, maxArgs: 2 },
  { name: 'floor', summary: 'floor(number)', minArgs: 1, maxArgs: 1 },
  { name: 'ceil', summary: 'ceil(number)', minArgs: 1, maxArgs: 1 },
  { name: 'sqrt', summary: 'sqrt(number)', minArgs: 1, maxArgs: 1 },
  { name: 'sign', summary: 'sign(number) — -1, 0 or 1', minArgs: 1, maxArgs: 1 },
  { name: 'min', summary: 'min(a, b, …)', minArgs: 1, maxArgs: null },
  { name: 'max', summary: 'max(a, b, …)', minArgs: 1, maxArgs: null },
  { name: 'sum', summary: 'sum(a, b, …)', minArgs: 1, maxArgs: null },
  { name: 'average', summary: 'average(a, b, …)', minArgs: 1, maxArgs: null },
  { name: 'toNumber', summary: 'toNumber(text) — fails visibly when it is not one', minArgs: 1, maxArgs: 1 },
  { name: 'toText', summary: 'toText(value)', minArgs: 1, maxArgs: 1 },
  { name: 'concat', summary: 'concat(a, b, …)', minArgs: 1, maxArgs: null },
  { name: 'join', summary: 'join(separator, a, b, …)', minArgs: 2, maxArgs: null },
  { name: 'length', summary: 'length(text or list)', minArgs: 1, maxArgs: 1 },
  { name: 'upper', summary: 'upper(text)', minArgs: 1, maxArgs: 1 },
  { name: 'lower', summary: 'lower(text)', minArgs: 1, maxArgs: 1 },
  { name: 'trim', summary: 'trim(text)', minArgs: 1, maxArgs: 1 },
  { name: 'slice', summary: 'slice(text, from, to)', minArgs: 2, maxArgs: 3 },
  { name: 'contains', summary: 'contains(text or list, part)', minArgs: 2, maxArgs: 2 },
  { name: 'startsWith', summary: 'startsWith(text, part)', minArgs: 2, maxArgs: 2 },
  { name: 'endsWith', summary: 'endsWith(text, part)', minArgs: 2, maxArgs: 2 },
  { name: 'replace', summary: 'replace(text, find, with) — plain text, never a pattern', minArgs: 3, maxArgs: 3 },
  { name: 'now', summary: 'now() — this moment', minArgs: 0, maxArgs: 0 },
  { name: 'today', summary: 'today() — this day', minArgs: 0, maxArgs: 0 },
  { name: 'date', summary: 'date(text) — read text as a date', minArgs: 1, maxArgs: 1 },
  { name: 'dateAdd', summary: 'dateAdd(date, amount, "days")', minArgs: 3, maxArgs: 3 },
  { name: 'dateSubtract', summary: 'dateSubtract(date, amount, "days")', minArgs: 3, maxArgs: 3 },
  { name: 'dateBetween', summary: 'dateBetween(later, earlier, "days")', minArgs: 3, maxArgs: 3 },
  { name: 'year', summary: 'year(date)', minArgs: 1, maxArgs: 1 },
  { name: 'month', summary: 'month(date) — 1 to 12', minArgs: 1, maxArgs: 1 },
  { name: 'day', summary: 'day(date) — 1 to 31', minArgs: 1, maxArgs: 1 },
  { name: 'timestamp', summary: 'timestamp(date) — milliseconds', minArgs: 1, maxArgs: 1 },
];

const SPECS = new Map(FORMULA_FUNCTIONS.map((spec) => [spec.name, spec] as const));

const UNITS: Readonly<Record<string, number>> = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
};

/** Months and years are not a fixed number of milliseconds, so they get calendar arithmetic. */
const CALENDAR_UNITS = new Set(['months', 'years']);

function unitOf(value: FormulaValue): string | FormulaValue {
  const name = asText(value);
  if (typeof name !== 'string') return name;
  const unit = name.trim().toLowerCase();
  if (UNITS[unit] !== undefined || CALENDAR_UNITS.has(unit)) return unit;
  return err(
    'type_mismatch',
    `“${unit}” is not a unit. Use seconds, minutes, hours, days, weeks, months or years.`,
  );
}

function asDateMs(value: FormulaValue): { ms: number; day: boolean } | FormulaValue {
  if (isError(value)) return value;
  if (value.kind === 'empty') return EMPTY;
  const raw = value.kind === 'date' ? value.value
    : value.kind === 'text' ? normaliseDateValue(value.value)
    : null;
  if (raw === null) return err('type_mismatch', `This needs a date and was given ${typeName(value)}.`);
  const ms = datePropertyMs(raw);
  if (ms === null) return err('type_mismatch', 'That is not a date this build can read.');
  return { ms, day: DAY_ONLY(raw) };
}

/**
 * The instants a stored date can SPELL: `0000-01-01` to `9999-12-31`.
 *
 * Narrower than `Date`'s own ±8.64e15 range, and deliberately. Past a four-digit
 * year `toISOString()` emits an expanded one (`+275760-09-13T00:00:00.000Z`),
 * which is not a value `normaliseDateValue` reads back — so a date arithmetic
 * that landed there stored a string no later read could parse. Worse for the day
 * path: `iso.slice(0, 10)` over `-271821-04-20…` yields `-271771-04`, a date cell
 * holding a malformed date and no error beside it.
 */
const MIN_STORABLE_DATE_MS = -62_167_219_200_000;
const MAX_STORABLE_DATE_MS = 253_402_300_799_999;

/**
 * Back to a stored spelling — a day stays a day, so a due date does not gain a
 * time.
 *
 * Out of range is a TYPED ERROR rather than a throw. `new Date(ms).toISOString()`
 * raises `RangeError: Invalid time value` past ±8.64e15, and that exception left
 * this file, left `evaluateNode`, and aborted the whole `projectDatabase` call —
 * so one row's `dateAdd(Due, 100000000, "days")` blanked every other row's view
 * and returned a 500 from the server's read. The engine's contract is that it
 * returns a value for every input; a range check is how that stays true.
 */
function fromMs(ms: number, day: boolean): FormulaValue {
  if (!Number.isFinite(ms) || ms < MIN_STORABLE_DATE_MS || ms > MAX_STORABLE_DATE_MS) {
    return err('type_mismatch', 'That date arithmetic lands on a date this cannot write down.');
  }
  const iso = new Date(ms).toISOString();
  return date(day ? iso.slice(0, 10) : iso);
}

function shiftCalendar(ms: number, amount: number, unit: string, day: boolean): FormulaValue {
  const d = new Date(ms);
  if (unit === 'years') d.setUTCFullYear(d.getUTCFullYear() + amount);
  else {
    const targetMonth = d.getUTCMonth() + amount;
    const dayOfMonth = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(targetMonth);
    // Clamped rather than allowed to roll over: 31 January plus one month is
    // 28 February, not 3 March. Rolling over is how a monthly renewal date
    // quietly drifts a few days per year.
    const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(dayOfMonth, lastOfMonth));
  }
  return fromMs(d.getTime(), day);
}

function numbersOf(args: readonly FormulaValue[]): number[] | FormulaValue {
  const out: number[] = [];
  for (const arg of args) {
    if (isError(arg)) return arg;
    // An empty operand is SKIPPED by an aggregate rather than absorbing it:
    // `sum(a, b, c)` over a row where one is blank is the total of what is
    // there, which is what a person adding up a partly-filled row means. That is
    // the opposite of `a + b`, deliberately — `+` has two named operands and an
    // aggregate has a set.
    if (arg.kind === 'empty') continue;
    const n = asNumber(arg);
    if (typeof n !== 'number') return n;
    out.push(n);
  }
  return out;
}

function callFunction(name: string, args: FormulaValue[], ctx: FormulaContext): FormulaValue {
  switch (name) {
    /* ------------------------------------------------------------- logic */
    // `if` is not here: `evaluateNode` handles it before the arguments are
    // evaluated, because the branch not taken must not report an error. A copy
    // here would be a second implementation of the one function whose whole
    // point is WHEN it evaluates.
    case 'empty':
      return isError(args[0]!) ? args[0]! : bool(args[0]!.kind === 'empty');
    case 'ifEmpty':
      return isError(args[0]!) ? args[0]!
        : args[0]!.kind === 'empty' ? args[1]! : args[0]!;
    case 'not': {
      const value = asBoolean(args[0]!);
      return typeof value === 'boolean' ? bool(!value) : value;
    }

    /* ----------------------------------------------------------- numbers */
    case 'abs': case 'floor': case 'ceil': case 'sqrt': case 'sign': {
      if (args[0]!.kind === 'empty') return EMPTY;
      const n = asNumber(args[0]!);
      if (typeof n !== 'number') return n;
      if (name === 'abs') return num(Math.abs(n));
      if (name === 'floor') return num(Math.floor(n));
      if (name === 'ceil') return num(Math.ceil(n));
      if (name === 'sign') return num(Math.sign(n));
      return n < 0
        ? err('type_mismatch', 'A square root of a negative number is not a number.')
        : num(Math.sqrt(n));
    }
    case 'round': {
      if (args[0]!.kind === 'empty') return EMPTY;
      const n = asNumber(args[0]!);
      if (typeof n !== 'number') return n;
      const places = args.length > 1 ? asNumber(args[1]!) : 0;
      if (typeof places !== 'number') return places;
      // Bounded: 10 ** 400 is Infinity, and a rounding that overflows would
      // return a number nobody asked for.
      const factor = 10 ** Math.min(12, Math.max(0, Math.trunc(places)));
      return num(Math.round(n * factor) / factor);
    }
    case 'min': case 'max': case 'sum': case 'average': {
      const numbers = numbersOf(args);
      if (!Array.isArray(numbers)) return numbers;
      if (numbers.length === 0) return EMPTY;
      if (name === 'min') return num(Math.min(...numbers));
      if (name === 'max') return num(Math.max(...numbers));
      const total = numbers.reduce((a, b) => a + b, 0);
      return num(name === 'sum' ? total : total / numbers.length);
    }
    case 'toNumber': {
      if (args[0]!.kind === 'empty') return EMPTY;
      if (args[0]!.kind === 'number') return args[0]!;
      const asString = asText(args[0]!);
      if (typeof asString !== 'string') return asString;
      const parsed = Number(asString.trim());
      return asString.trim().length > 0 && Number.isFinite(parsed)
        ? num(parsed)
        : err('type_mismatch', `“${asString.slice(0, 40)}” is not a number.`);
    }

    /* -------------------------------------------------------------- text */
    case 'toText': {
      const value = asText(args[0]!);
      return typeof value === 'string' ? text(value) : value;
    }
    case 'concat': case 'join': {
      const separator = name === 'join' ? asText(args[0]!) : '';
      if (typeof separator !== 'string') return separator;
      const parts: string[] = [];
      let total = 0;
      for (const arg of args.slice(name === 'join' ? 1 : 0)) {
        if (isError(arg)) return arg;
        if (arg.kind === 'empty') continue;
        const part = asText(arg);
        if (typeof part !== 'string') return part;
        total += part.length + separator.length;
        // Checked as it accumulates rather than only at the end: the point of
        // the cap is that a hostile formula never allocates the string.
        if (total > MAX_FORMULA_TEXT) {
          return err('too_large', `A formula's text result holds at most ${MAX_FORMULA_TEXT} characters.`);
        }
        parts.push(part);
      }
      return text(parts.join(separator));
    }
    case 'length': {
      if (args[0]!.kind === 'list') return num(args[0]!.value.length);
      if (args[0]!.kind === 'empty') return num(0);
      const value = asText(args[0]!);
      return typeof value === 'string' ? num(value.length) : value;
    }
    case 'upper': case 'lower': case 'trim': {
      if (args[0]!.kind === 'empty') return EMPTY;
      const value = asText(args[0]!);
      if (typeof value !== 'string') return value;
      return text(name === 'upper' ? value.toUpperCase() : name === 'lower' ? value.toLowerCase() : value.trim());
    }
    case 'slice': {
      if (args[0]!.kind === 'empty') return EMPTY;
      const value = asText(args[0]!);
      if (typeof value !== 'string') return value;
      const from = asNumber(args[1]!);
      if (typeof from !== 'number') return from;
      if (args.length < 3) return text(value.slice(Math.trunc(from)));
      const to = asNumber(args[2]!);
      if (typeof to !== 'number') return to;
      return text(value.slice(Math.trunc(from), Math.trunc(to)));
    }
    case 'contains': case 'startsWith': case 'endsWith': {
      const needle = asText(args[1]!);
      if (typeof needle !== 'string') return needle;
      if (args[0]!.kind === 'list') {
        // A list is asked about as a SET, matching how a multi-select cell is
        // filtered — otherwise a tag called "ops" would answer true for a row
        // tagged only "devops".
        return name === 'contains'
          ? bool(args[0]!.value.includes(needle))
          : err('type_mismatch', `${name}() reads text, and this is a list.`);
      }
      if (args[0]!.kind === 'empty') return bool(false);
      const haystack = asText(args[0]!);
      if (typeof haystack !== 'string') return haystack;
      if (name === 'contains') return bool(haystack.includes(needle));
      if (name === 'startsWith') return bool(haystack.startsWith(needle));
      return bool(haystack.endsWith(needle));
    }
    case 'replace': {
      if (args[0]!.kind === 'empty') return EMPTY;
      const haystack = asText(args[0]!);
      if (typeof haystack !== 'string') return haystack;
      const find = asText(args[1]!);
      if (typeof find !== 'string') return find;
      const to = asText(args[2]!);
      if (typeof to !== 'string') return to;
      if (find.length === 0) return text(haystack);
      // `replaceAll` on a plain STRING, never a pattern. Compiling a stored
      // string into a regular expression is the ReDoS this repository already
      // closed once, reintroduced through a formula that syncs between devices.
      const replaced = haystack.split(find).join(to);
      return text(replaced);
    }

    /* ------------------------------------------------------------- dates */
    case 'now': return date(new Date(ctx.nowMs).toISOString());
    case 'today': return date(new Date(ctx.nowMs).toISOString().slice(0, 10));
    case 'date': {
      if (args[0]!.kind === 'empty') return EMPTY;
      if (args[0]!.kind === 'date') return args[0]!;
      const value = asText(args[0]!);
      if (typeof value !== 'string') return value;
      const normalised = normaliseDateValue(value);
      return normalised === null
        ? err('type_mismatch', `“${value.slice(0, 40)}” is not a date.`)
        : date(normalised);
    }
    case 'dateAdd': case 'dateSubtract': {
      const base = asDateMs(args[0]!);
      if (!isDateParts(base)) return base;
      const amountValue = asNumber(args[1]!);
      if (typeof amountValue !== 'number') return amountValue;
      const unit = unitOf(args[2]!);
      if (typeof unit !== 'string') return unit;
      const amount = name === 'dateAdd' ? amountValue : -amountValue;
      if (CALENDAR_UNITS.has(unit)) return shiftCalendar(base.ms, Math.trunc(amount), unit, base.day);
      return fromMs(base.ms + amount * UNITS[unit]!, base.day);
    }
    case 'dateBetween': {
      const later = asDateMs(args[0]!);
      if (!isDateParts(later)) return later;
      const earlier = asDateMs(args[1]!);
      if (!isDateParts(earlier)) return earlier;
      const unit = unitOf(args[2]!);
      if (typeof unit !== 'string') return unit;
      if (unit === 'years' || unit === 'months') {
        const a = new Date(later.ms);
        const b = new Date(earlier.ms);
        const months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
        // Whole units only: a difference of "1 month" between 31 Jan and
        // 1 Mar is 1, not 1.03, because a person asking how many months apart
        // two dates are is counting boundaries.
        const whole = a.getUTCDate() < b.getUTCDate() ? months - 1 : months;
        return num(unit === 'months' ? whole : Math.trunc(whole / 12));
      }
      return num((later.ms - earlier.ms) / UNITS[unit]!);
    }
    case 'year': case 'month': case 'day': case 'timestamp': {
      const parts = asDateMs(args[0]!);
      if (!isDateParts(parts)) return parts;
      const d = new Date(parts.ms);
      if (name === 'year') return num(d.getUTCFullYear());
      if (name === 'month') return num(d.getUTCMonth() + 1);
      if (name === 'day') return num(d.getUTCDate());
      return num(parts.ms);
    }

    default:
      return err('unknown_function', `There is no function called ${name}().`);
  }
}

function isDateParts(value: { ms: number; day: boolean } | FormulaValue): value is { ms: number; day: boolean } {
  return typeof (value as { ms?: number }).ms === 'number';
}

/* ---------------------------------------------------------------- the walk */

/**
 * Evaluate one node.
 *
 * `if` is the one function whose arguments are NOT all evaluated first — the
 * branch not taken must not report an error, or `if(prop("Rate") = 0, 0,
 * prop("Cost") / prop("Rate"))` fails on exactly the rows the person wrote the
 * guard for.
 */
export function evaluateNode(node: FormulaNode, ctx: FormulaContext, depth = 0): FormulaValue {
  // Derived from the parser's TOKEN cap, not chosen independently, because the
  // two bounds have to agree about what is acceptable. `parseExpression` bounds
  // NESTING and recurses only on the right, so `1+1+…` builds a left-leaning
  // tree as deep as it is wide — and a fixed 64 here refused flat chains past 64
  // terms that the parser had already accepted. A parsed tree has at most one
  // node per token, so this can never refuse the parser's output; it is a stack
  // guard for a caller that builds a node tree by hand.
  if (depth > MAX_FORMULA_TOKENS) {
    return err('too_deep', 'This formula is nested too deeply to work out.');
  }
  switch (node.t) {
    case 'number': return num(node.value);
    case 'text': return text(node.value);
    case 'boolean': return bool(node.value);
    case 'property': return ctx.property(node.name);
    case 'unary': {
      const value = evaluateNode(node.arg, ctx, depth + 1);
      if (isError(value)) return value;
      if (node.op === '-') {
        if (value.kind === 'empty') return EMPTY;
        const n = asNumber(value);
        return typeof n === 'number' ? num(-n) : n;
      }
      const b = asBoolean(value);
      return typeof b === 'boolean' ? bool(!b) : b;
    }
    case 'binary': return evaluateBinary(node, ctx, depth);
    case 'call': {
      const spec = SPECS.get(node.name);
      if (!spec) return err('unknown_function', `There is no function called ${node.name}().`);
      if (node.args.length < spec.minArgs || (spec.maxArgs !== null && node.args.length > spec.maxArgs)) {
        return err('arity', `${node.name}() is written ${spec.summary}.`);
      }
      if (node.name === 'if') {
        const test = evaluateNode(node.args[0]!, ctx, depth + 1);
        const decided = asBoolean(test);
        if (typeof decided !== 'boolean') return decided;
        return evaluateNode(node.args[decided ? 1 : 2]!, ctx, depth + 1);
      }
      const args = node.args.map((arg) => evaluateNode(arg, ctx, depth + 1));
      // Every other function propagates an error from any argument before it
      // runs, so nothing computes a result from a failure.
      if (node.name !== 'empty' && node.name !== 'ifEmpty') {
        const error = firstError(args);
        if (error) return error;
      }
      return callFunction(node.name, args, ctx);
    }
  }
}
