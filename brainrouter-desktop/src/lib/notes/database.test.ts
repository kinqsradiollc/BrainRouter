/**
 * ADR-029 E3 — the database views, tested where the judgement is.
 *
 * The projection itself is core's and is tested there. What is asserted here is
 * the half a projection cannot decide, and every one of these has a failure mode
 * that is invisible until someone loses a row:
 *
 *   - the no-value bucket survives into the board and the calendar (E3's whole
 *     argument is that a row is a page and cannot go missing),
 *   - a card is only draggable where the drop can write the WHOLE value,
 *   - a filter editor that cannot show a nested group carries it through rather
 *     than flattening someone's saved view,
 *   - a rule is created with an operator core will actually evaluate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boardColumns, calendarModel, canDragBetweenGroups, cellEditorFor, defaultCalendarAnchor,
  emptyViewLine, filterSummary, filterValueEditor, flatFilter, groupDropValue,
  groupableProperties, isCompleteFilterRule, monthGrid, newFilterRule, nestedFilterNote,
  nextSortDirection, selectOptionId, shiftMonth, toggleHeaderSort, toggleMultiValue,
  viewNotices, visibleProperties, writeFilter,
  type DatabasePropertyDto, type DatabaseReadDto, type DatabaseRowDto,
} from './database.js';

function property(over: Partial<DatabasePropertyDto> = {}): DatabasePropertyDto {
  return {
    id: 'status', name: 'Status', type: 'select', unsupported: false,
    operators: ['is', 'is-not', 'is-any-of', 'is-none-of', 'is-empty', 'is-not-empty'],
    options: [{ id: 'todo', label: 'To do' }, { id: 'done', label: 'Done' }],
    ...over,
  };
}

function row(id: string, title = id): DatabaseRowDto {
  return { id, title, icon: null, cover: null, cells: [] };
}

function dto(over: Partial<DatabaseReadDto> = {}): DatabaseReadDto {
  const properties = over.properties ?? [
    { id: 'title', name: 'Name', type: 'title', unsupported: false, operators: ['is', 'contains'] },
    property(),
  ];
  return {
    found: true,
    id: 'db_1',
    title: 'Reading list',
    views: [{ id: 'table', name: 'Table', kind: 'table' }],
    view: { id: 'table', name: 'Table', kind: 'table', visible: properties.map((p) => p.id) },
    kind: 'table',
    properties,
    columns: properties.map((p) => p.id),
    rows: [],
    groups: [],
    total: 0,
    filteredOut: 0,
    skipped: [],
    notices: [],
    ...over,
  };
}

/* ------------------------------------------------------------------- cells */

test('a column this build cannot evaluate is read-only, not missing', () => {
  // §3 keeps formulas out and a newer client's type arrives the same way. An
  // editable field over a value we do not understand lets someone overwrite it
  // with something we do, which is worse than showing it as it is stored.
  assert.equal(cellEditorFor(property({ type: 'formula', unsupported: true })), 'none');
  assert.equal(cellEditorFor(property({ type: 'formula', unsupported: false })), 'none');
  assert.equal(cellEditorFor(property({ type: 'select' })), 'select');
  assert.equal(cellEditorFor(property({ type: 'relation' })), 'relation');
});

test('a multi-value cell keeps the order of the entries a toggle did not touch', () => {
  assert.deepEqual(toggleMultiValue(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(toggleMultiValue(['a', 'c'], 'b'), ['a', 'c', 'b']);
  assert.deepEqual(toggleMultiValue(null, 'b'), ['b']);
});

test('an option id is seeded from the label once, so renaming it keeps the values', () => {
  const taken = new Set<string>();
  const first = selectOptionId('In progress', taken);
  assert.equal(first, 'in-progress');
  taken.add(first);
  // A second option with the same name gets its own id rather than colliding —
  // two options sharing an id would make one option's rows appear under the
  // other.
  assert.equal(selectOptionId('In progress', taken), 'in-progress-2');
  assert.equal(selectOptionId('  ', taken), 'option');
});

/* ------------------------------------------------------------------- board */

test('the board keeps every bucket core produced, including the empty and the no-value one', () => {
  const model = dto({
    kind: 'board',
    rows: [row('r1'), row('r2')],
    groups: [
      { key: 'todo', label: 'To do', empty: false, rowIds: ['r1'] },
      // Seeded from the schema with nothing in it. A column that disappears
      // because it is empty is a column you cannot drag onto.
      { key: 'done', label: 'Done', empty: false, rowIds: [] },
      { key: null, label: 'No Status', empty: true, rowIds: ['r2'] },
    ],
  });
  const columns = boardColumns(model);
  assert.deepEqual(columns.map((column) => column.label), ['To do', 'Done', 'No Status']);
  assert.equal(columns[1]!.rows.length, 0);
  // E3: a row with no grouping value is SHOWN, in its own column, not dropped.
  assert.deepEqual(columns[2]!.rows.map((r) => r.id), ['r2']);
  assert.equal(columns[2]!.noValue, true);
});

test('a card is draggable only where the drop can write the whole value', () => {
  assert.equal(canDragBetweenGroups(property({ type: 'select' })), true);
  assert.equal(canDragBetweenGroups(property({ type: 'checkbox' })), true);
  // A multi-select card is in EVERY column its tags name, so a drop would have
  // to replace the list and would silently delete the other tags.
  assert.equal(canDragBetweenGroups(property({ type: 'multi-select' })), false);
  // A calendar cell is a day; dropping would discard the time that was stored.
  assert.equal(canDragBetweenGroups(property({ type: 'date' })), false);
  assert.equal(canDragBetweenGroups(property({ type: 'select', unsupported: true })), false);
  assert.equal(canDragBetweenGroups(null), false);
});

test('dropping on the no-value column clears the cell rather than writing a word', () => {
  assert.equal(groupDropValue(property({ type: 'select' }), 'done'), 'done');
  assert.equal(groupDropValue(property({ type: 'select' }), null), null);
  // A checkbox is never empty (core: an unset checkbox IS false), so its two
  // columns are the two booleans.
  assert.equal(groupDropValue(property({ type: 'checkbox' }), 'true'), true);
  assert.equal(groupDropValue(property({ type: 'checkbox' }), 'false'), false);
});

/* ---------------------------------------------------------------- calendar */

test('the month grid is always six Monday-first weeks, so stepping a month does not reflow the page', () => {
  const weeks = monthGrid('2026-02-01');
  assert.equal(weeks.length, 6);
  assert.equal(weeks[0]!.length, 7);
  // 1 Feb 2026 is a Sunday, so a Monday-first grid leads with six days of
  // January and the 1st lands in the last column of the first week.
  assert.equal(weeks[0]![6]!.key, '2026-02-01');
  assert.equal(weeks[0]![6]!.inMonth, true);
  assert.equal(weeks[0]![0]!.inMonth, false);
});

test('the calendar shows undated rows instead of dropping them, and counts the ones off-screen', () => {
  const model = calendarModel(dto({
    kind: 'calendar',
    rows: [row('r1'), row('r2'), row('r3')],
    groups: [
      { key: '2026-02-10', label: '2026-02-10', empty: false, rowIds: ['r1'] },
      { key: '2026-05-02', label: '2026-05-02', empty: false, rowIds: ['r2'] },
      { key: null, label: 'Unscheduled', empty: true, rowIds: ['r3'] },
    ],
  }), '2026-02-01');

  const placed = model.weeks.flat().find((day) => day.key === '2026-02-10');
  assert.deepEqual(placed?.rows.map((r) => r.id), ['r1']);
  // The no-value bucket is rendered beside the grid, with core's own label.
  assert.deepEqual(model.unscheduled.map((r) => r.id), ['r3']);
  assert.equal(model.unscheduledLabel, 'Unscheduled');
  // A row three months away is counted rather than silently absent.
  assert.equal(model.offMonth, 1);
});

test('a calendar grouped by something that is not a date lists those rows rather than hiding them', () => {
  const model = calendarModel(dto({
    kind: 'calendar',
    rows: [row('r1')],
    groups: [{ key: 'todo', label: 'To do', empty: false, rowIds: ['r1'] }],
  }), '2026-02-01');
  assert.equal(model.weeks.flat().every((day) => day.rows.length === 0), true);
  assert.deepEqual(model.unplaced.map((bucket) => bucket.label), ['To do']);
  assert.deepEqual(model.unplaced[0]!.rows.map((r) => r.id), ['r1']);
});

test('a calendar opens on the earliest scheduled row, not on an empty grid', () => {
  const model = dto({
    kind: 'calendar',
    groups: [
      { key: '2026-05-02', label: '2026-05-02', empty: false, rowIds: [] },
      { key: '2025-11-30', label: '2025-11-30', empty: false, rowIds: [] },
      { key: null, label: 'Unscheduled', empty: true, rowIds: [] },
    ],
  });
  assert.equal(defaultCalendarAnchor(model), '2025-11-01');
  // With nothing to place it opens on today rather than on 1970.
  assert.equal(defaultCalendarAnchor(dto({ kind: 'calendar' }), Date.UTC(2026, 7, 7)), '2026-08-01');
});

test('stepping a month crosses the year end without landing on an invalid day', () => {
  assert.equal(shiftMonth('2026-12-01', 1), '2027-01-01');
  assert.equal(shiftMonth('2026-01-01', -1), '2025-12-01');
});

/* ----------------------------------------------------------------- notices */

test('the strip says what core could not apply before it says how many rows are hidden', () => {
  const lines = viewNotices(dto({
    total: 5,
    filteredOut: 2,
    notices: ['This version cannot read Estimate.'],
    skipped: [{ kind: 'sort', property: 'estimate', reason: 'unsupported_type', detail: 'Estimate cannot be sorted.' }],
  }));
  assert.deepEqual(lines, [
    'This version cannot read Estimate.',
    'Estimate cannot be sorted.',
    '2 rows are hidden by this view’s filter. 5 in the database.',
  ]);
  assert.deepEqual(viewNotices(dto()), []);
});

test('an empty view says which kind of empty it is', () => {
  assert.match(emptyViewLine(dto({ total: 0 })), /No rows yet/);
  assert.match(emptyViewLine(dto({ total: 4, filteredOut: 4 })), /hidden by this view/);
});

/* -------------------------------------------------------------------- sort */

test('a third click on a column header removes the sort rather than flipping it again', () => {
  assert.equal(nextSortDirection(null), 'asc');
  assert.equal(nextSortDirection('asc'), 'desc');
  assert.equal(nextSortDirection('desc'), null);

  assert.deepEqual(toggleHeaderSort(undefined, 'status'), [{ property: 'status', direction: 'asc' }]);
  assert.deepEqual(
    toggleHeaderSort([{ property: 'status', direction: 'asc' }], 'status'),
    [{ property: 'status', direction: 'desc' }],
  );
  assert.deepEqual(toggleHeaderSort([{ property: 'status', direction: 'desc' }], 'status'), []);
  // Clicking a different header replaces the rule; a silently appended
  // tie-break would produce an order nobody could explain from the screen.
  assert.deepEqual(
    toggleHeaderSort([{ property: 'status', direction: 'asc' }], 'title'),
    [{ property: 'title', direction: 'asc' }],
  );
});

/* ------------------------------------------------------------------ filter */

test('a nested group this editor cannot show is carried through, not flattened away', () => {
  const nested = { combinator: 'or' as const, rules: [{ property: 'status', operator: 'is' as const, value: 'todo' }] };
  const flat = flatFilter({
    combinator: 'and',
    rules: [{ property: 'title', operator: 'contains', value: 'x' }, nested],
  });
  assert.equal(flat.rules.length, 1);
  assert.equal(flat.nested.length, 1);
  assert.match(nestedFilterNote(flat)!, /still applies/);

  const written = writeFilter(flat);
  assert.deepEqual(written!.rules[1], nested, 'the saved view lost a condition it still applies');
  // Nothing left means no filter at all: a stored empty group would leave the
  // toolbar claiming a filter that does nothing.
  assert.equal(writeFilter({ combinator: 'and', rules: [], nested: [] }), undefined);
});

test('a new rule uses an operator core will actually evaluate for that type', () => {
  // A multi-select has no `is`, so a rule created with one would be reported as
  // skipped the moment it was saved.
  const multi = property({
    id: 'tags', type: 'multi-select',
    operators: ['contains', 'does-not-contain', 'contains-all', 'is-any-of', 'is-none-of', 'is-empty', 'is-not-empty'],
  });
  assert.equal(newFilterRule(multi)!.operator, 'contains');
  // An operator that asks about emptiness carries no value at all.
  const empty = property({ operators: ['is-empty'] });
  assert.equal('value' in newFilterRule(empty)!, false);
  assert.equal(newFilterRule(property({ operators: [] })), null);
});

test('a half-built condition is not saved, so picking a column does not empty the view', () => {
  // Core reads `status is <nothing>` as matching nothing — correctly, an empty
  // cell must not satisfy a comparison — so a rule saved the instant its
  // property was picked hides every row and the honest notice underneath
  // describes a filter the person had not finished making.
  assert.equal(isCompleteFilterRule({ property: 'status', operator: 'is', value: null }), false);
  assert.equal(isCompleteFilterRule({ property: 'status', operator: 'is', value: '  ' }), false);
  assert.equal(isCompleteFilterRule({ property: 'tags', operator: 'is-any-of', value: [] }), false);

  assert.equal(isCompleteFilterRule({ property: 'status', operator: 'is', value: 'todo' }), true);
  // These two ask about emptiness, so they carry no value and are complete.
  assert.equal(isCompleteFilterRule({ property: 'status', operator: 'is-empty' }), true);
  // A checkbox is complete at `false` — false is a value there, not an absence.
  assert.equal(isCompleteFilterRule({ property: 'starred', operator: 'is', value: false }), true);
});

test('a rule value editor follows the OPERATOR, not only the property type', () => {
  const select = property();
  assert.equal(filterValueEditor(select, 'is'), 'select');
  // `is-any-of` takes a list where the cell takes one option.
  assert.equal(filterValueEditor(select, 'is-any-of'), 'multi-select');
  assert.equal(filterValueEditor(select, 'is-empty'), 'none');
  // Core compares a multi-value cell as a SET, so `contains` asks about one
  // member.
  assert.equal(filterValueEditor(property({ type: 'multi-select' }), 'contains'), 'select');
  assert.equal(filterValueEditor(property({ type: 'relation' }), 'links-to'), 'relation');
});

test('the toolbar counts the conditions that are actually applied, nested ones included', () => {
  assert.equal(filterSummary(dto()), 'Filter');
  const filtered = dto();
  filtered.view.filter = {
    combinator: 'and',
    rules: [
      { property: 'status', operator: 'is', value: 'todo' },
      { combinator: 'or', rules: [{ property: 'title', operator: 'contains', value: 'x' }] },
    ],
  };
  assert.equal(filterSummary(filtered), '2 filters');
});

/* ----------------------------------------------------------------- columns */

test('a view renders the columns it lists, in its order, and nothing it does not', () => {
  const model = dto();
  model.columns = ['status'];
  assert.deepEqual(visibleProperties(model).map((p) => p.id), ['status']);
  // A column the schema lost is not rendered as a header with no cells under it.
  model.columns = ['status', 'gone'];
  assert.deepEqual(visibleProperties(model).map((p) => p.id), ['status']);
});

test('grouping is offered only where core can evaluate it', () => {
  const model = dto({
    properties: [
      { id: 'title', name: 'Name', type: 'title', unsupported: false, operators: ['is'] },
      property(),
      property({ id: 'estimate', name: 'Estimate', type: 'formula', unsupported: true, operators: [] }),
    ],
  });
  // The title column groups every row into its own bucket, and a property core
  // reports as unsupported would be skipped and leave one column called "All
  // rows" with nothing the person could act on.
  assert.deepEqual(groupableProperties(model).map((p) => p.id), ['status']);
});
