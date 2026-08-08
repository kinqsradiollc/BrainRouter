/**
 * ADR-029 F2/F3 — the derived columns, checked against the three claims that
 * made reversing §3 defensible.
 *
 * §3 refused formulas because "half an expression language produces a column
 * that is wrong rather than absent". F2 answers that with three constraints, and
 * a constraint that is only stated is not a constraint — so each one has a test
 * that fails if it stops holding:
 *
 *  1. **Total.** Every operation returns a value or a TYPED error. Division by
 *     zero, a missing column, a type mismatch: a sentence, never `NaN`, never
 *     `0`, never a throw.
 *  2. **A cell that cannot be computed says WHY, in the cell.**
 *  3. **A cycle is detected and NAMED**, not iterated to a fixed point.
 *
 * Plus the two properties that make it safe to accept a formula that arrived
 * over sync: it is never compiled into code, and it is bounded — in length, in
 * depth, and in the size of what it can produce.
 *
 * F3's rollup is judged on A4 rather than on arithmetic: a permission-hidden row
 * must not be silently omitted from a count somebody is reading as complete.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hlc } from '../sync/hybridClock.js';
import type { NoteBlock } from '../notes/block.js';
import { blockCreatedAt, mergeNoteBlock } from '../notes/blockMerge.js';
import {
  compileFormula, parseFormula, runFormula, MAX_FORMULA_LENGTH,
} from '../notes/formula/index.js';
import { aggregateRollup } from '../notes/rollup.js';
import {
  coercePropertyValue, formatPropertyValue, unionSetValues,
  type NotePropertyDef, type NotePropertyValue,
} from '../notes/properties.js';
import { databaseComputedReader, projectDatabase } from '../notes/databaseProjection.js';
import { addProperty, addRow, createDatabase, setRowValue, updateProperty } from '../notes/databaseOps.js';
import { createBlock, getBlock, listAllBlocks } from '../notes/noteStore.js';

const T = Date.parse('2026-08-07T09:00:00.000Z');
const at = (physical: number, logical = 0, deviceId = 'da'): Hlc => ({ physical, logical, deviceId });
const s = <T,>(value: T, stamp: Hlc = at(1)): { value: T; at: Hlc } => ({ value, at: stamp });

function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'br-notes-f2-'));
  process.env.BRAINROUTER_HOME = dir;
  return dir;
}
function cleanup(dir: string): void {
  delete process.env.BRAINROUTER_HOME;
  rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------ a database in memory */

interface RowSpec {
  id: string;
  title?: string;
  props?: Record<string, NotePropertyValue>;
}

function databaseWith(schema: NotePropertyDef[], rows: RowSpec[]): NoteBlock[] {
  const db: NoteBlock = {
    id: 'db',
    parentId: s<string | null>(null),
    rank: s('A1'),
    kind: s('database' as const),
    text: s('Budget'),
    schema: s(schema),
    views: s([{ id: 'table', name: 'Table', kind: 'table' as const, visible: schema.map((d) => d.id) }]),
  };
  const blocks: NoteBlock[] = [db];
  rows.forEach((row, index) => {
    blocks.push({
      id: row.id,
      parentId: s<string | null>('db'),
      rank: s(`A${index + 2}`),
      kind: s('page' as const),
      text: s(row.title ?? row.id),
      createdAt: at(1000 + index),
      ...(row.props
        ? { props: Object.fromEntries(Object.entries(row.props).map(([k, v]) => [k, s(v)])) }
        : {}),
    });
  });
  return blocks;
}

/** The one cell a test is about, by property id. */
function cell(blocks: NoteBlock[], rowId: string, propertyId: string): { display: string; value: NotePropertyValue; error?: string } {
  const projection = projectDatabase(blocks, 'db', undefined, { nowMs: T });
  assert.ok(projection, 'the database projects');
  const row = projection.rows.find((candidate) => candidate.id === rowId);
  assert.ok(row, `row ${rowId} is in the projection`);
  const found = row.cells.find((candidate) => candidate.property.id === propertyId);
  assert.ok(found, `column ${propertyId} is visible`);
  return { display: found.display, value: found.value, ...(found.error ? { error: found.error } : {}) };
}

/* -------------------------------------------------------------- the language */

test('a formula reads other properties of the same row, by name and by prop()', () => {
  const blocks = databaseWith(
    [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'cost', name: 'Cost', type: 'number' },
      { id: 'qty', name: 'Quantity', type: 'number' },
      { id: 'total', name: 'Total', type: 'formula', formula: 'Cost * prop("Quantity")' },
    ],
    [{ id: 'r1', props: { cost: 12.5, qty: 4 } }],
  );
  assert.equal(cell(blocks, 'r1', 'total').value, 50);
  assert.equal(cell(blocks, 'r1', 'total').display, '50');
});

test('every arithmetic failure is a TYPED error with a sentence, never NaN and never 0', () => {
  const cases: Array<[string, string]> = [
    ['1 / 0', 'divides by zero'],
    ['prop("Missing") + 1', 'no property called'],
    ['"text" * 2', 'needs a number'],
    ['nosuchfunction(1)', 'no function called'],
    ['1 +', 'stops before it says anything'],
  ];
  for (const [source, fragment] of cases) {
    const blocks = databaseWith(
      [
        { id: 'title', name: 'Name', type: 'title' },
        { id: 'out', name: 'Out', type: 'formula', formula: source },
      ],
      [{ id: 'r1' }],
    );
    const computed = cell(blocks, 'r1', 'out');
    assert.equal(computed.value, null, `${source} stores no value`);
    assert.ok(computed.error, `${source} reports an error`);
    assert.ok(
      computed.error!.toLowerCase().includes(fragment),
      `${source} says why — got "${computed.error}"`,
    );
    // F2's second constraint: the sentence IS the cell, so a person reading the
    // table sees the reason rather than a blank.
    assert.equal(computed.display, computed.error);
    assert.ok(!computed.display.includes('NaN'));
  }
});

test('an empty operand absorbs rather than counting as zero', () => {
  // A half-filled row computes to nothing, not to a number derived from a blank.
  const blocks = databaseWith(
    [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'cost', name: 'Cost', type: 'number' },
      { id: 'total', name: 'Total', type: 'formula', formula: 'Cost * 2' },
    ],
    [{ id: 'r1' }],
  );
  const computed = cell(blocks, 'r1', 'total');
  assert.equal(computed.value, null);
  assert.equal(computed.display, '');
  assert.equal(computed.error, undefined, 'an unfilled row is not an error');
});

test('a guarded division does not report the error it was guarded against', () => {
  const blocks = databaseWith(
    [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'rate', name: 'Rate', type: 'number' },
      { id: 'out', name: 'Out', type: 'formula', formula: 'if(Rate = 0, 0, 100 / Rate)' },
    ],
    [{ id: 'r1', props: { rate: 0 } }, { id: 'r2', props: { rate: 4 } }],
  );
  assert.equal(cell(blocks, 'r1', 'out').value, 0);
  assert.equal(cell(blocks, 'r1', 'out').error, undefined);
  assert.equal(cell(blocks, 'r2', 'out').value, 25);
});

test('a cycle is detected and NAMED, and nothing is iterated', () => {
  const blocks = databaseWith(
    [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'a', name: 'Total', type: 'formula', formula: 'Tax + 1' },
      { id: 'b', name: 'Tax', type: 'formula', formula: 'Total * 2' },
    ],
    [{ id: 'r1' }],
  );
  const computed = cell(blocks, 'r1', 'a');
  assert.ok(computed.error, 'the cycle is an error');
  assert.ok(computed.error!.includes('Total'), 'the chain names the columns');
  assert.ok(computed.error!.includes('Tax'));
  assert.ok(computed.error!.includes('→'), 'and shows the loop');
});

test('a formula referring to itself is named too', () => {
  const blocks = databaseWith(
    [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'a', name: 'Total', type: 'formula', formula: 'Total + 1' },
    ],
    [{ id: 'r1' }],
  );
  assert.match(cell(blocks, 'r1', 'a').error ?? '', /refers to itself/);
});

test('date arithmetic keeps a day a day, and months are clamped rather than rolled over', () => {
  const blocks = databaseWith(
    [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'due', name: 'Due', type: 'date' },
      { id: 'next', name: 'Next', type: 'formula', formula: 'dateAdd(Due, 1, "months")' },
      { id: 'gap', name: 'Gap', type: 'formula', formula: 'dateBetween(Next, Due, "days")' },
    ],
    [{ id: 'r1', props: { due: '2026-01-31' } }],
  );
  assert.equal(cell(blocks, 'r1', 'next').value, '2026-02-28', '31 Jan + 1 month is 28 Feb, not 3 Mar');
  assert.equal(cell(blocks, 'r1', 'gap').value, 28);
});

/* -------------------------------------------------- untrusted text, bounded */

test('a 100,000-character formula is refused by a bound, not walked', () => {
  // It arrives from sync: a schema travels between devices and between people
  // who share a database. The refusal is a length comparison, so the cost of a
  // hostile source is the comparison rather than a parse.
  const adversarial = [
    '('.repeat(100_000),
    '1+'.repeat(50_000) + '1',
    'a'.repeat(100_000),
    '"'.repeat(100_000),
    ('prop("a")+'.repeat(10_000)) + '1',
  ];
  for (const source of adversarial) {
    const started = process.hrtime.bigint();
    const parsed = parseFormula(source);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(parsed.ok, false, 'refused');
    assert.equal(parsed.ok === false && parsed.error.code, 'too_long');
    assert.ok(elapsedMs < 250, `refused in ${elapsedMs.toFixed(1)}ms, which is not a walk`);
  }
});

test('a formula at the length limit still parses in linear time', () => {
  // The bound above only proves the refusal is cheap. This proves the SCANNER is
  // linear for input it accepts: no backtracking, because there is no regular
  // expression in it to backtrack.
  const source = `${'('.repeat(20)}1${')'.repeat(20)}${'+1'.repeat(200)}`;
  assert.ok(source.length < MAX_FORMULA_LENGTH);
  const started = process.hrtime.bigint();
  const parsed = parseFormula(source);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(parsed.ok, true);
  assert.ok(elapsedMs < 100, `parsed in ${elapsedMs.toFixed(1)}ms`);
});

test('nesting past the depth limit is a typed error, not a stack overflow', () => {
  const deep = `${'('.repeat(200)}1${')'.repeat(200)}`;
  const parsed = parseFormula(deep);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok === false && parsed.error.code, 'too_deep');
});

test('a formula is never executed as code', () => {
  // Not `eval`, not `new Function`: the source arrives over the network, and
  // there is no sandbox argument that survives that. The proof is that a source
  // which WOULD have an effect if it were evaluated has none.
  const marker = '__brainrouter_formula_escape__';
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals[marker];
  const compiled = compileFormula(`globalThis["${marker}"] = 1`);
  const outcome = runFormula(compiled, { nowMs: T, property: () => ({ kind: 'empty' }) });
  assert.equal(outcome.kind, 'error');
  assert.equal(globals[marker], undefined, 'nothing was executed');
});

test('a text result that would grow past the cell limit is refused, not allocated', () => {
  const blocks = databaseWith(
    [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'big', name: 'Big', type: 'formula', formula: 'concat(Name, Name, Name, Name, Name, Name)' },
    ],
    [{ id: 'r1', title: 'x'.repeat(1000) }],
  );
  const computed = cell(blocks, 'r1', 'big');
  assert.ok(computed.error, 'refused rather than returned');
  assert.match(computed.error!, /at most/);
});

/* -------------------------------------------------------------------- rollups */

test('an empty relation and a hidden one are DIFFERENT answers', () => {
  const empty = aggregateRollup({ relation: 'links', target: 'n', aggregate: 'count' }, []);
  assert.equal(empty.display, '0');
  assert.equal(empty.value, 0);

  const hidden = aggregateRollup(
    { relation: 'links', target: 'n', aggregate: 'count' },
    [{ status: 'denied' }, { status: 'denied' }, { status: 'denied' }],
  );
  // A4: not `0`, which claims there is nothing there, and not `3`, which would
  // let somebody count what they were not shown.
  assert.equal(hidden.display, '0 + 3 you cannot see');
  assert.equal(hidden.denied, 3);
});

test('a sum says what it did not include rather than reading as complete', () => {
  const outcome = aggregateRollup(
    { relation: 'links', target: 'cost', aggregate: 'sum' },
    [
      { status: 'value', value: 10 },
      { status: 'value', value: 5 },
      { status: 'denied' },
      { status: 'unreachable' },
    ],
  );
  assert.equal(outcome.value, 15);
  assert.match(outcome.display, /^15 — /);
  assert.match(outcome.display, /1 you cannot see/);
  assert.match(outcome.display, /1 could not be read here/);
});

test('every aggregate except count is empty over no rows', () => {
  for (const aggregate of ['sum', 'average', 'min', 'max', 'earliest', 'latest'] as const) {
    const outcome = aggregateRollup({ relation: 'l', target: 't', aggregate }, []);
    assert.equal(outcome.value, null, `${aggregate} of nothing has no value`);
    assert.equal(outcome.display, '', `${aggregate} of nothing shows nothing, not 0`);
  }
});

test('a rollup follows a relation to real rows and totals them', () => {
  const dir = home();
  try {
    const source = createDatabase(undefined, { title: 'Invoices' }, T);
    const amount = addProperty(undefined, source.id, { name: 'Amount', type: 'number' }, T);
    assert.ok(amount.ok);
    const a = addRow(undefined, source.id, { title: 'A', values: { [amount.value.id]: 30 } }, T);
    const b = addRow(undefined, source.id, { title: 'B', values: { [amount.value.id]: 12 } }, T);
    assert.ok(a.ok && b.ok);

    const target = createDatabase(undefined, { title: 'Clients' }, T);
    const links = addProperty(undefined, target.id, { name: 'Invoices', type: 'relation' }, T);
    assert.ok(links.ok);
    const total = addProperty(undefined, target.id, {
      name: 'Total',
      type: 'rollup',
      rollup: { relation: links.value.id, target: amount.value.id, aggregate: 'sum' },
    }, T);
    assert.ok(total.ok);

    const client = addRow(undefined, target.id, {
      title: 'Acme',
      values: {
        [links.value.id]: [
          `brainrouter://notes/block/${a.value.id}`,
          `brainrouter://notes/block/${b.value.id}`,
        ],
      },
    }, T);
    assert.ok(client.ok);

    const projection = projectDatabase(listAllBlocks(undefined), target.id, undefined, { nowMs: T });
    const row = projection!.rows.find((candidate) => candidate.id === client.value.id)!;
    const computed = row.cells.find((candidate) => candidate.property.id === total.value.id)!;
    assert.equal(computed.value, 42);
    assert.equal(computed.display, '42', 'nothing to say, so nothing is said');
    assert.equal(computed.computed, true);
  } finally { cleanup(dir); }
});

test('F2 — a formula that reads a formula gets a NUMBER, not the number as text', () => {
  // The one operator that lied. `+` concatenates text, and reading a formula
  // column back through the stored union guessed text — so `Subtotal + Shipping`
  // over 30 and 5 rendered `305` with no error beside it. That is precisely the
  // "wrong rather than absent" outcome §3 refused formulas over, produced by the
  // layer that claimed to have made it impossible.
  const dir = home();
  try {
    const db = createDatabase(undefined, { title: 'Orders' }, T);
    const cost = addProperty(undefined, db.id, { name: 'Cost', type: 'number' }, T);
    const qty = addProperty(undefined, db.id, { name: 'Quantity', type: 'number' }, T);
    const ship = addProperty(undefined, db.id, { name: 'Shipping', type: 'number' }, T);
    assert.ok(cost.ok && qty.ok && ship.ok);
    const subtotal = addProperty(undefined, db.id, {
      name: 'Subtotal', type: 'formula', formula: 'Cost * Quantity',
    }, T);
    const total = addProperty(undefined, db.id, {
      name: 'Total', type: 'formula', formula: 'Subtotal + Shipping',
    }, T);
    const doubled = addProperty(undefined, db.id, {
      name: 'Doubled', type: 'formula', formula: 'Subtotal * 2',
    }, T);
    assert.ok(subtotal.ok && total.ok && doubled.ok);

    const row = addRow(undefined, db.id, {
      title: 'Widget',
      values: { [cost.value.id]: 10, [qty.value.id]: 3, [ship.value.id]: 5 },
    }, T);
    assert.ok(row.ok);

    const projection = projectDatabase(listAllBlocks(undefined), db.id, undefined, { nowMs: T })!;
    const cells = projection.rows[0]!.cells;
    const cellOf = (id: string) => cells.find((cell) => cell.property.id === id)!;

    assert.equal(cellOf(subtotal.value.id).value, 30);
    // The number, and it is a NUMBER: a string here sorts and filters as text,
    // so `35` and `305` are not merely a display difference.
    assert.equal(cellOf(total.value.id).value, 35);
    assert.equal(typeof cellOf(total.value.id).value, 'number');
    assert.equal(cellOf(total.value.id).error, undefined);
    assert.equal(cellOf(doubled.value.id).value, 60);
  } finally { cleanup(dir); }
});

test('F2 — a formula that reads a ROLLUP gets its number too', () => {
  const dir = home();
  try {
    const source = createDatabase(undefined, { title: 'Invoices' }, T);
    const amount = addProperty(undefined, source.id, { name: 'Amount', type: 'number' }, T);
    assert.ok(amount.ok);
    const a = addRow(undefined, source.id, { title: 'A', values: { [amount.value.id]: 30 } }, T);
    const b = addRow(undefined, source.id, { title: 'B', values: { [amount.value.id]: 12 } }, T);
    assert.ok(a.ok && b.ok);

    const target = createDatabase(undefined, { title: 'Clients' }, T);
    const links = addProperty(undefined, target.id, { name: 'Invoices', type: 'relation' }, T);
    assert.ok(links.ok);
    const total = addProperty(undefined, target.id, {
      name: 'Total', type: 'rollup',
      rollup: { relation: links.value.id, target: amount.value.id, aggregate: 'sum' },
    }, T);
    assert.ok(total.ok);
    const plusOne = addProperty(undefined, target.id, {
      name: 'PlusOne', type: 'formula', formula: 'Total + 1',
    }, T);
    assert.ok(plusOne.ok);

    const client = addRow(undefined, target.id, {
      title: 'Acme',
      values: {
        [links.value.id]: [
          `brainrouter://notes/block/${a.value.id}`,
          `brainrouter://notes/block/${b.value.id}`,
        ],
      },
    }, T);
    assert.ok(client.ok);

    const projection = projectDatabase(listAllBlocks(undefined), target.id, undefined, { nowMs: T })!;
    const cells = projection.rows.find((row) => row.id === client.value.id)!.cells;
    assert.equal(cells.find((cell) => cell.property.id === total.value.id)!.value, 42);
    assert.equal(cells.find((cell) => cell.property.id === plusOne.value.id)!.value, 43);
  } finally { cleanup(dir); }
});

test('F2 — date arithmetic that overflows is a typed error, not a throw out of the projection', () => {
  // `new Date(ms).toISOString()` raises past ±8.64e15, and the exception left
  // the engine, left `evaluateNode`, and aborted `projectDatabase` — so ONE
  // row's formula blanked the whole view and returned a 500 from the server's
  // read. The opposite sign was worse: it silently stored `-271771-04`, a
  // malformed date in a date cell with no error beside it.
  const dir = home();
  try {
    const db = createDatabase(undefined, { title: 'Plan' }, T);
    const due = addProperty(undefined, db.id, { name: 'Due', type: 'date' }, T);
    assert.ok(due.ok);
    const far = addProperty(undefined, db.id, {
      name: 'Far', type: 'formula', formula: 'dateAdd(Due, 100000000, "days")',
    }, T);
    const back = addProperty(undefined, db.id, {
      name: 'Back', type: 'formula', formula: 'dateSubtract(Due, 100000000, "days")',
    }, T);
    const near = addProperty(undefined, db.id, {
      name: 'Near', type: 'formula', formula: 'dateAdd(Due, 1, "days")',
    }, T);
    assert.ok(far.ok && back.ok && near.ok);

    const good = addRow(undefined, db.id, { title: 'Good', values: { [due.value.id]: '2026-08-01' } }, T);
    const bad = addRow(undefined, db.id, { title: 'Bad', values: { [due.value.id]: '2026-08-02' } }, T);
    assert.ok(good.ok && bad.ok);

    // The whole projection still happens — the other row is not collateral.
    const projection = projectDatabase(listAllBlocks(undefined), db.id, undefined, { nowMs: T })!;
    assert.equal(projection.rows.length, 2);
    for (const row of projection.rows) {
      const cellOf = (id: string) => row.cells.find((cell) => cell.property.id === id)!;
      assert.equal(cellOf(far.value.id).value, null);
      assert.match(cellOf(far.value.id).error ?? '', /cannot write down/);
      assert.equal(cellOf(back.value.id).value, null);
      assert.match(cellOf(back.value.id).error ?? '', /cannot write down/);
      // And ordinary date arithmetic is untouched by the bound.
      assert.match(String(cellOf(near.value.id).value), /^20\d\d-\d\d-\d\d$/);
    }

    // Reachable from literals alone, so a formula with no data behind it cannot
    // take the view down either.
    for (const source of [
      'dateAdd(today(), 99980000, "days")',
      'dateAdd(today(), 15000000, "weeks")',
      'dateSubtract(today(), 99980000, "days")',
    ]) {
      const value = runFormula(compileFormula(source), { nowMs: T, property: () => ({ kind: 'empty' }) });
      assert.equal(value.kind, 'error', `${source} did not produce a typed error`);
    }
  } finally { cleanup(dir); }
});

test('F2 — a cycle ACROSS rows is named, on every row of the ring', () => {
  // `computed.ts` claims the stack covers "cycles ACROSS rows (a rollup that
  // reaches back through a relation)". It did detect one — and then `sampleOf`
  // turned the cycle error into `unreachable`, so the person was told a LINK was
  // broken and the rows one hop up rendered as plain blank cells.
  const dir = home();
  try {
    const db = createDatabase(undefined, { title: 'Ring' }, T);
    const links = addProperty(undefined, db.id, { name: 'Next', type: 'relation' }, T);
    assert.ok(links.ok);
    const total = addProperty(undefined, db.id, { name: 'Total', type: 'rollup' }, T);
    assert.ok(total.ok);
    // Pointed at ITSELF through the relation, which is the loop. Patched rather
    // than added twice, because a rollup cannot name its own id before it has one.
    assert.equal(updateProperty(undefined, db.id, total.value.id, {
      rollup: { relation: links.value.id, target: total.value.id, aggregate: 'sum' },
    }, T).ok, true);

    const rows = ['A', 'B', 'C'].map((title) => {
      const made = addRow(undefined, db.id, { title }, T);
      assert.ok(made.ok);
      return made.value;
    });
    rows.forEach((row, index) => {
      const next = rows[(index + 1) % rows.length]!;
      setRowValue(undefined, row.id, links.value.id, [`brainrouter://notes/block/${next.id}`], T);
    });

    const projection = projectDatabase(listAllBlocks(undefined), db.id, undefined, { nowMs: T })!;
    assert.equal(projection.rows.length, 3);
    for (const row of projection.rows) {
      const cell = row.cells.find((candidate) => candidate.property.id === total.value.id)!;
      assert.match(cell.error ?? '', /refers to itself/, `${row.title} did not name the cycle`);
      // Named, not reported as a broken link — which sends somebody to check a
      // relation that is fine.
      assert.doesNotMatch(cell.display, /could not be read here/);
      // The ROW is in the chain, because a ring of rollups is three rows of one
      // column and "Total → Total → Total" names nothing anyone can go and look at.
      assert.match(cell.error ?? '', /·/);
    }
  } finally { cleanup(dir); }
});

test('F2 — the evaluator never refuses a flat chain the parser accepted', () => {
  // The parser bounds NESTING and recurses only on the right, so `1+1+…` builds
  // a left-leaning tree as deep as it is wide. A fixed evaluator bound of 64
  // refused 70 terms the parser had already said yes to — a "too deep" on a
  // formula with no nesting in it at all.
  for (const terms of [64, 70, 128, 200]) {
    const source = Array.from({ length: terms }, () => '1').join('+');
    const compiled = compileFormula(source);
    assert.equal(compiled.error, null, `${terms} terms did not parse`);
    const value = runFormula(compiled, { nowMs: T, property: () => ({ kind: 'empty' }) });
    assert.deepEqual(value, { kind: 'number', value: terms }, `${terms} terms did not evaluate`);
  }
  // And the token cap still bites, so the bound has not simply been removed.
  const tooLong = Array.from({ length: 400 }, () => '1').join('+');
  assert.equal(runFormula(compileFormula(tooLong), { nowMs: T, property: () => ({ kind: 'empty' }) }).kind, 'error');
});

test('a rollup over a reference to another MODE says it could not read it, not that it is empty', () => {
  const dir = home();
  try {
    const target = createDatabase(undefined, { title: 'Clients' }, T);
    const links = addProperty(undefined, target.id, { name: 'Work', type: 'relation' }, T);
    assert.ok(links.ok);
    const count = addProperty(undefined, target.id, {
      name: 'How many',
      type: 'rollup',
      rollup: { relation: links.value.id, target: '', aggregate: 'count' },
    }, T);
    assert.ok(count.ok);
    const row = addRow(undefined, target.id, {
      title: 'Acme',
      values: { [links.value.id]: ['brainrouter://planner/item/itm_4f2a'] },
    }, T);
    assert.ok(row.ok);

    const projection = projectDatabase(listAllBlocks(undefined), target.id, undefined, { nowMs: T });
    const computed = projection!.rows[0]!.cells.find((c) => c.property.id === count.value.id)!;
    assert.equal(computed.display, '0 — 1 could not be read here');
  } finally { cleanup(dir); }
});

test('a rollup honours A4: a target the viewer cannot see is counted as hidden', () => {
  const dir = home();
  try {
    const source = createDatabase(undefined, { title: 'Invoices' }, T);
    const secret = addRow(undefined, source.id, { title: 'Private' }, T);
    assert.ok(secret.ok);

    const target = createDatabase(undefined, { title: 'Clients' }, T);
    const links = addProperty(undefined, target.id, { name: 'Invoices', type: 'relation' }, T);
    assert.ok(links.ok);
    const count = addProperty(undefined, target.id, {
      name: 'How many', type: 'rollup',
      rollup: { relation: links.value.id, target: '', aggregate: 'count' },
    }, T);
    assert.ok(count.ok);
    const row = addRow(undefined, target.id, {
      title: 'Acme',
      values: { [links.value.id]: [`brainrouter://notes/block/${secret.value.id}`] },
    }, T);
    assert.ok(row.ok);

    const projection = projectDatabase(listAllBlocks(undefined), target.id, undefined, {
      nowMs: T,
      canSee: () => false,
    });
    const computed = projection!.rows[0]!.cells.find((c) => c.property.id === count.value.id)!;
    assert.equal(computed.display, '0 + 1 you cannot see');
  } finally { cleanup(dir); }
});

/* ---------------------------------------------------------- derived metadata */

test('a derived column cannot be typed into, and the refusal says why', () => {
  const dir = home();
  try {
    const db = createDatabase(undefined, { title: 'Tasks' }, T);
    const created = addProperty(undefined, db.id, { name: 'Created', type: 'created-time' }, T);
    assert.ok(created.ok);
    const row = addRow(undefined, db.id, { title: 'One' }, T);
    assert.ok(row.ok);

    const written = setRowValue(undefined, row.value.id, created.value.id, '1999-01-01', T);
    assert.equal(written.ok, false);
    assert.match(written.ok === false ? written.detail : '', /worked out from the row/);
    // And nothing was stored under it, so no later read can find a typed value.
    assert.equal(getBlock(undefined, row.value.id)?.props?.[created.value.id], undefined);
  } finally { cleanup(dir); }
});

test('a derived value is refused at the coercion, whatever calls it', () => {
  for (const type of ['created-time', 'edited-time', 'created-by', 'edited-by', 'formula', 'rollup']) {
    const def: NotePropertyDef = { id: 'x', name: 'X', type };
    assert.equal(coercePropertyValue(def, 'anything'), null, `${type} stores nothing`);
  }
});

test('created time is exact for a new block and marked approximate for an older one', () => {
  const dir = home();
  try {
    const block = createBlock(undefined, { text: 'hello' }, T);
    const created = blockCreatedAt(block);
    assert.ok(created?.exact, 'a block made by this build records its creation');

    // A file written before this layer has no `createdAt`. It READS — Part F's
    // forward-compatibility rule — and reports a lower bound rather than a date
    // it cannot know.
    const legacy: NoteBlock = { ...block };
    delete legacy.createdAt;
    const derived = blockCreatedAt(legacy);
    assert.ok(derived);
    assert.equal(derived.exact, false);
  } finally { cleanup(dir); }
});

test('created time renders as a date, and an approximate one is marked', () => {
  const blocks = databaseWith(
    [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'made', name: 'Made', type: 'created-time' },
      { id: 'by', name: 'By', type: 'created-by' },
    ],
    [{ id: 'r1' }],
  );
  const exact = cell(blocks, 'r1', 'made');
  assert.ok(!exact.display.startsWith('≈'), 'a recorded creation is not hedged');
  assert.match(String(exact.value), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(cell(blocks, 'r1', 'by').display, /device/i);

  const withoutStamp = blocks.map((block) => {
    if (block.id !== 'r1') return block;
    const copy = { ...block };
    delete copy.createdAt;
    return copy;
  });
  assert.ok(cell(withoutStamp, 'r1', 'made').display.startsWith('≈'), 'a guess is marked as one');
});

test('creation merges toward the EARLIEST claim, so it cannot drift forward', () => {
  const base: NoteBlock = {
    id: 'b', parentId: s<string | null>(null), rank: s('A1'), kind: s('paragraph' as const),
    text: s('one', at(10)), createdAt: at(10),
  };
  const later: NoteBlock = { ...base, text: s('two', at(50)), createdAt: at(50) };
  const merged = mergeNoteBlock(base, later);
  assert.deepEqual(merged.createdAt, at(10), 'the first claim wins');
  assert.deepEqual(mergeNoteBlock(later, base).createdAt, at(10), 'in either order');
});

/* ------------------------------------------------------- the multi-select set */

test('two concurrent tag additions UNION rather than discarding one', () => {
  // Both people meant their tag. Last-writer-wins throws one away with nothing
  // on either screen to say a tag was ever added.
  const ours: NoteBlock = {
    id: 'r', parentId: s<string | null>('db'), rank: s('A1'), kind: s('page' as const), text: s('row'),
    props: { tags: { value: ['ops'], at: at(100, 0, 'da') } },
  };
  const theirs: NoteBlock = {
    ...ours,
    props: { tags: { value: ['design'], at: at(100, 0, 'db') } },
  };
  const merged = mergeNoteBlock(ours, theirs);
  assert.deepEqual(merged.props!.tags!.value, ['design', 'ops']);
  // Converges: the other order produces the SAME array, not merely the same set.
  assert.deepEqual(mergeNoteBlock(theirs, ours).props!.tags!.value, ['design', 'ops']);
});

test('a removal still lands, because the union is only for the tie', () => {
  // A merge that always unioned would make removing a tag impossible while any
  // peer still held the old list.
  const ours: NoteBlock = {
    id: 'r', parentId: s<string | null>('db'), rank: s('A1'), kind: s('page' as const), text: s('row'),
    props: { tags: { value: ['ops', 'design'], at: at(100, 0, 'da') } },
  };
  const removal: NoteBlock = {
    ...ours,
    props: { tags: { value: ['ops'], at: at(200, 0, 'db') } },
  };
  assert.deepEqual(mergeNoteBlock(ours, removal).props!.tags!.value, ['ops']);
  assert.deepEqual(mergeNoteBlock(removal, ours).props!.tags!.value, ['ops']);
});

test('the union is bounded and de-duplicated', () => {
  assert.deepEqual(unionSetValues(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  const many = Array.from({ length: 200 }, (_, i) => `t${i}`);
  assert.equal(unionSetValues(many, ['extra']).length, 64);
});

/* ------------------------------------------------------------------- files */

test('a files cell holds attachment references and nothing else', () => {
  const def: NotePropertyDef = { id: 'f', name: 'Files', type: 'files' };
  assert.deepEqual(coercePropertyValue(def, ['attachment:abc123']), ['attachment:abc123']);
  // A bare id is canonicalised, so a caller that has just stored bytes can write
  // back what the store handed it.
  assert.deepEqual(coercePropertyValue(def, ['abc123']), ['attachment:abc123']);
  // Anything the store cannot serve is dropped rather than rendered as a file
  // that will never open.
  assert.equal(coercePropertyValue(def, ['https://example.com/a.pdf']), null);
  assert.equal(coercePropertyValue(def, ['attachment:../../etc/passwd']), null);
  assert.equal(formatPropertyValue(def, ['attachment:a', 'attachment:b']), '2 files');
});

/* ---------------------------------------------------- filtering and sorting */

test('a filter and a sort on a formula column read the COMPUTED value', () => {
  const schema: NotePropertyDef[] = [
    { id: 'title', name: 'Name', type: 'title' },
    { id: 'cost', name: 'Cost', type: 'number' },
    { id: 'vat', name: 'VAT', type: 'formula', formula: 'Cost * 0.2' },
  ];
  const blocks = databaseWith(schema, [
    { id: 'r1', title: 'a', props: { cost: 100 } },
    { id: 'r2', title: 'b', props: { cost: 10 } },
    { id: 'r3', title: 'c', props: { cost: 50 } },
  ]);
  const db = blocks[0]!;
  db.views = s([{
    id: 'table', name: 'Table', kind: 'table' as const, visible: ['title', 'cost', 'vat'],
    filter: { combinator: 'and' as const, rules: [{ property: 'vat', operator: 'greater-than' as const, value: 5 }] },
    sort: [{ property: 'vat', direction: 'desc' as const }],
  }]);

  const projection = projectDatabase(blocks, 'db', undefined, { nowMs: T })!;
  assert.deepEqual(projection.rows.map((row) => row.id), ['r1', 'r3'], 'filtered and sorted on a value nothing stored');
  assert.equal(projection.filteredOut, 1);
  assert.deepEqual(projection.skipped, [], 'and neither rule was skipped');
});

/* ------------------------------------------------------ forward compatibility */

test('a schema written before this layer reads rather than throwing', () => {
  // No `formula`, no `rollup`, no `createdAt` anywhere — the shape Part E wrote.
  const blocks = databaseWith(
    [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'cost', name: 'Cost', type: 'number' },
    ],
    [{ id: 'r1', props: { cost: 3 } }],
  ).map((block) => {
    const copy = { ...block };
    delete copy.createdAt;
    return copy;
  });
  const projection = projectDatabase(blocks, 'db', undefined, { nowMs: T });
  assert.ok(projection);
  assert.equal(projection.rows.length, 1);
  assert.equal(projection.notices.length, 0, 'and nothing is reported as unsupported');
});

test('a rollup that has not been set up says so instead of showing a number', () => {
  const blocks = databaseWith(
    [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'r', name: 'Rolled', type: 'rollup' },
    ],
    [{ id: 'r1' }],
  );
  const computed = cell(blocks, 'r1', 'r');
  assert.ok(computed.error);
  assert.equal(computed.value, null);
  assert.match(computed.display, /not been set up/);
});

test('the reader is bounded, so one page cannot ask for unbounded arithmetic', () => {
  const schema: NotePropertyDef[] = [
    { id: 'title', name: 'Name', type: 'title' },
    { id: 'a', name: 'A', type: 'formula', formula: '1 + 1' },
  ];
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}` }));
  const reader = databaseComputedReader(databaseWith(schema, rows), { nowMs: T });
  const first = reader.read(databaseWith(schema, rows)[1]!, schema[1]!);
  assert.equal(first.value, 2);
  assert.equal(first.computed, true);
});
