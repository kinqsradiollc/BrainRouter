/**
 * ADR-029 F2 — the formula engine's one door.
 *
 * Three files behind it, split by what each one is allowed to know: `value.ts`
 * knows types and errors, `parse.ts` knows syntax and knows nothing about
 * databases, `evaluate.ts` knows arithmetic and asks a callback what a property
 * is. The join between a formula and a ROW is here, and nowhere else, which is
 * what keeps the parser reusable by anything that needs to bound untrusted
 * expression text later.
 *
 * **A formula's result is never stored.** F2's rule, and the reason is A2's one
 * level down: a derived value written into `props` would be a cache that syncs,
 * and a cache that syncs is a second source of truth that can disagree with a
 * recompute. `coercePropertyValue` returns `null` for a formula column
 * specifically so that a client which does not understand the type cannot push
 * one back as data.
 */
import {
  datePropertyMs, formatPropertyValue, isEmptyPropertyValue,
  type NotePropertyDef, type NotePropertyValue,
} from '../properties.js';

import { evaluateNode, type FormulaContext } from './evaluate.js';
import { formulaDependencies, parseFormula, type FormulaNode } from './parse.js';
import { err, isError, type FormulaValue } from './value.js';

export * from './value.js';
export {
  parseFormula, formulaDependencies, MAX_FORMULA_DEPTH, MAX_FORMULA_TOKENS,
  type FormulaNode, type ParseResult, type BinaryOp,
} from './parse.js';
export {
  evaluateNode, FORMULA_FUNCTIONS,
  type FormulaContext, type FormulaFunctionSpec,
} from './evaluate.js';

/**
 * A stored cell as a formula value.
 *
 * The SELECT branch is the one worth pointing at: a formula sees an option's
 * LABEL, not its stored id. The id is an implementation detail of how a rename
 * stays safe (see `selectOptionId` on the desktop), and a person writing
 * `prop("Status") = "In progress"` means the words they can see. Comparing
 * against the id would fail for a reason nothing on screen could explain.
 */
export function propertyValueAsFormula(
  def: NotePropertyDef,
  value: NotePropertyValue,
): FormulaValue {
  if (isEmptyPropertyValue(value) && def.type !== 'checkbox') return { kind: 'empty' };

  switch (def.type) {
    case 'number':
      return typeof value === 'number'
        ? { kind: 'number', value }
        : { kind: 'empty' };
    case 'checkbox':
      return { kind: 'boolean', value: value === true };
    case 'date':
    case 'created-time':
    case 'edited-time':
      return typeof value === 'string' && datePropertyMs(value) !== null
        ? { kind: 'date', value }
        : { kind: 'empty' };
    case 'multi-select':
    case 'person':
    case 'relation':
    case 'files':
      return {
        kind: 'list',
        value: Array.isArray(value) ? value.map((entry) => String(entry)) : [String(value)],
      };
    case 'select':
      return { kind: 'text', value: formatPropertyValue(def, value) };
    case 'formula':
    case 'rollup':
      // A DERIVED column has no declared result type — the type is whatever the
      // expression worked out. Falling into `default:` read every one of them as
      // TEXT, and `+` concatenates text: `Subtotal + Shipping` over 30 and 5 gave
      // `"305"` with no error beside it, which is the "wrong rather than absent"
      // outcome F2 exists to make impossible. The runtime shape is the only
      // evidence available here, so it is what decides.
      //
      // `computed.ts` does not come through this path — it carries the engine's
      // own `FormulaValue` — so this is the answer for a caller holding a stored
      // cell and nothing else.
      return formulaValueOfStored(value);
    default:
      // Title, text, url, created-by, edited-by, and anything a newer client
      // wrote whose value is a plain string: read as text rather than refused,
      // because a formula over an unfamiliar column is still a formula over a
      // string somebody can see.
      return Array.isArray(value)
        ? { kind: 'list', value: value.map((entry) => String(entry)) }
        : { kind: 'text', value: String(value) };
  }
}

/**
 * A value whose declared type is unknown, read as what it plainly is.
 *
 * Used for the two columns that have no declared result type. A date-shaped
 * string becomes a `date` rather than text so `dateBetween(prop("Earliest"),
 * today(), "days")` works over a rollup — the alternative is a column a person
 * can see is a date and no date function will accept.
 */
export function formulaValueOfStored(value: NotePropertyValue): FormulaValue {
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'number', value } : { kind: 'empty' };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (Array.isArray(value)) return { kind: 'list', value: value.map((entry) => String(entry)) };
  if (typeof value === 'string') {
    // Strict ISO only, and anchored: `Date.parse` accepts "2026" and "May" as
    // dates, so inferring from it would turn a formula that produced the word
    // "May" into a date somebody then filtered a calendar by.
    const isoShaped = /^\d{4}-\d{2}-\d{2}(?:[T ].{0,32})?$/.test(value);
    return isoShaped && datePropertyMs(value) !== null ? { kind: 'date', value } : { kind: 'text', value };
  }
  return { kind: 'empty' };
}

/** A formula result as the union every cell speaks. `null` when it has no value. */
export function formulaValueAsProperty(value: FormulaValue): NotePropertyValue {
  switch (value.kind) {
    case 'number': return value.value;
    case 'text': return value.value;
    case 'boolean': return value.value;
    case 'date': return value.value;
    case 'list': return [...value.value];
    // An error is NOT a value. It is carried beside the cell so the surface can
    // render the sentence; storing the message here would make an error sort and
    // filter as though it were text somebody typed.
    case 'empty':
    case 'error': return null;
  }
}

/** One line for a cell. An error renders as its sentence — F2's "says why, in the cell". */
export function formatFormulaValue(value: FormulaValue): string {
  switch (value.kind) {
    case 'number': return formatFormulaNumber(value.value);
    case 'text': return value.value;
    case 'boolean': return value.value ? 'Yes' : 'No';
    case 'date': return value.value;
    case 'list': return value.value.join(', ');
    case 'empty': return '';
    case 'error': return value.message;
  }
}

/**
 * A number a person can read.
 *
 * Trailing float noise is trimmed — `0.1 + 0.2` renders as `0.3` rather than as
 * `0.30000000000000004`, which is true about IEEE 754 and useless in a cell.
 * Twelve significant decimals is well past any precision a person entered by
 * typing, so nothing they wrote is rounded away.
 */
export function formatFormulaNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  const trimmed = Number(value.toFixed(12));
  return String(trimmed);
}

export interface CompiledFormula {
  source: string;
  node: FormulaNode | null;
  /** Property names this formula reads. Empty when it did not parse. */
  dependencies: readonly string[];
  /** Set when the source is not a formula. Every row shows this same sentence. */
  error: FormulaValue | null;
}

/**
 * Parse once per column, not once per row.
 *
 * A database with four hundred rows would otherwise re-tokenise the same string
 * four hundred times per render. The compiled form is a pure function of the
 * source, so it is a cache that cannot disagree with a recompute — the only kind
 * A2 permits.
 */
export function compileFormula(source: string): CompiledFormula {
  const parsed = parseFormula(source ?? '');
  if (!parsed.ok) {
    return { source: source ?? '', node: null, dependencies: [], error: parsed.error };
  }
  return {
    source: source ?? '',
    node: parsed.node,
    dependencies: formulaDependencies(parsed.node),
    error: null,
  };
}

/** Run a compiled formula. A column that did not parse says so in every row. */
export function runFormula(compiled: CompiledFormula, ctx: FormulaContext): FormulaValue {
  if (!compiled.node) return compiled.error ?? err('syntax', 'This column has no formula in it yet.');
  return evaluateNode(compiled.node, ctx, 0);
}

export { isError as isFormulaError };
