/**
 * ADR-029 F2 — the values a formula can hold, and the errors it returns instead.
 *
 * F2's whole argument for reversing §3 is that the language is **total**: every
 * operation returns a value or a TYPED ERROR, never a wrong number. So there is
 * no `throw` anywhere in this engine and no `NaN` leaves it — an error is a
 * value of the same union as a number, it carries a code and a SENTENCE, and it
 * propagates through every operator that touches it.
 *
 * That is the difference between "half an expression language" and a small one.
 * A `sum` over a column with one bad cell must not quietly answer with the total
 * of the good ones; it answers with the reason, in the cell, where the person
 * reading the number is looking.
 *
 * **`empty` is a value, not an absence.** A blank cell in `1 + prop("Cost")` is
 * a real state a person can be in while they are still filling the row in, and
 * both plausible shortcuts are wrong: treating it as `0` invents a number nobody
 * entered, and erroring makes half a filled-in database look broken. It
 * absorbs — an arithmetic operand that is empty yields empty — which reads as
 * "this cannot be known yet" and is the only answer that is true.
 */

/** A number that is not a number is an error value, so `NaN` never escapes. */
export type FormulaErrorCode =
  /** The text is not a formula: a stray bracket, an unfinished string. */
  | 'syntax'
  /** Longer than a formula can be. Bounded because it arrives from sync. */
  | 'too_long'
  /** Nested past the depth limit — a parser bound, not a taste judgement. */
  | 'too_deep'
  /** A result that would be bigger than a cell can hold. */
  | 'too_large'
  /** `prop("…")` names a column this database does not have. */
  | 'unknown_property'
  | 'unknown_function'
  | 'arity'
  /** The operator does not apply to what it was given. */
  | 'type_mismatch'
  | 'divide_by_zero'
  /** A property that refers to itself, directly or around a loop. */
  | 'cycle'
  /** A column this build stores but cannot compute (a newer client's type). */
  | 'not_computable';

export interface FormulaError {
  kind: 'error';
  code: FormulaErrorCode;
  /** A sentence, because F2 says a cell that cannot be computed says WHY. */
  message: string;
}

export type FormulaValue =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'boolean'; value: boolean }
  /** Normalised by `normaliseDateValue`, so a day stays a day (see `properties.ts`). */
  | { kind: 'date'; value: string }
  | { kind: 'list'; value: readonly string[] }
  | { kind: 'empty' }
  | FormulaError;

/** A cell is not a document, and a formula is not a program. */
export const MAX_FORMULA_LENGTH = 2000;
/** A result a cell can hold, matching `MAX_PROPERTY_TEXT`. */
export const MAX_FORMULA_TEXT = 2000;

export const EMPTY: FormulaValue = { kind: 'empty' };

export function num(value: number): FormulaValue {
  // The one place a non-finite number can appear is an overflow inside
  // arithmetic; it becomes an error here rather than travelling as `Infinity`
  // and rendering as a word nobody typed.
  return Number.isFinite(value)
    ? { kind: 'number', value }
    : err('type_mismatch', 'That calculation does not have a number as its answer.');
}

export function text(value: string): FormulaValue {
  return value.length > MAX_FORMULA_TEXT
    ? err('too_large', `A formula's text result holds at most ${MAX_FORMULA_TEXT} characters.`)
    : { kind: 'text', value };
}

export function bool(value: boolean): FormulaValue {
  return { kind: 'boolean', value };
}

export function date(value: string): FormulaValue {
  return { kind: 'date', value };
}

export function list(value: readonly string[]): FormulaValue {
  return { kind: 'list', value };
}

export function err(code: FormulaErrorCode, message: string): FormulaError {
  return { kind: 'error', code, message };
}

export function isError(value: FormulaValue): value is FormulaError {
  return value.kind === 'error';
}

/**
 * The first error among the arguments, if any.
 *
 * Every operator calls this before doing anything else, which is what makes
 * propagation a property of the engine rather than a thing each function
 * remembers. One forgotten check is one operator that computes a number from an
 * error — which is the "wrong rather than absent" outcome F2 exists to rule out.
 */
export function firstError(values: readonly FormulaValue[]): FormulaError | null {
  for (const value of values) if (isError(value)) return value;
  return null;
}

/* ------------------------------------------------------------- conversions */

/** The name a type has in an error sentence. */
export function typeName(value: FormulaValue): string {
  switch (value.kind) {
    case 'number': return 'a number';
    case 'text': return 'text';
    case 'boolean': return 'a checkbox';
    case 'date': return 'a date';
    case 'list': return 'a list';
    case 'empty': return 'nothing';
    case 'error': return 'an error';
  }
}

/**
 * A value as a number, or the reason it is not one.
 *
 * Text is NOT coerced. `"12" + 1` reading as `13` is convenient exactly once and
 * then produces a column where `"1,200" + 1` is `1` — the shape of wrongness F2
 * refuses. A person who wants a number out of text writes `toNumber(…)`, which
 * says so and can fail visibly.
 */
export function asNumber(value: FormulaValue): number | FormulaError {
  if (value.kind === 'number') return value.value;
  if (isError(value)) return value;
  return err('type_mismatch', `This needs a number and was given ${typeName(value)}.`);
}

export function asText(value: FormulaValue): string | FormulaError {
  if (value.kind === 'text') return value.value;
  if (isError(value)) return value;
  if (value.kind === 'number') return String(value.value);
  if (value.kind === 'boolean') return value.value ? 'Yes' : 'No';
  if (value.kind === 'date') return value.value;
  if (value.kind === 'list') return value.value.join(', ');
  return '';
}

/**
 * Truthiness, which is deliberately narrow.
 *
 * Only a checkbox and `empty` answer this. `if(prop("Cost"), …)` on a number
 * column is almost always a mistake — the person meant `prop("Cost") > 0` — and
 * a language that guesses turns that mistake into a column that is confidently
 * wrong for the rows where the cost happens to be zero.
 */
export function asBoolean(value: FormulaValue): boolean | FormulaError {
  if (value.kind === 'boolean') return value.value;
  if (value.kind === 'empty') return false;
  if (isError(value)) return value;
  return err('type_mismatch', `This needs a checkbox and was given ${typeName(value)}.`);
}
