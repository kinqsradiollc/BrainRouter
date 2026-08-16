/**
 * ADR-029 F2/F3 — the derived columns, where the RENDERER decides.
 *
 * Core is tested for whether a formula is total and whether a rollup says what
 * it could not see. What is asserted here is the half core cannot: that the
 * surface draws those columns as what they are.
 *
 * The failure this guards is F1's, one layer in — a property type that exists in
 * core, is offered by the picker, and lands in a cell with no editor and no
 * explanation. A column somebody can add and then cannot read is the same defect
 * as a slash-menu entry that inserts a plain line of text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DERIVED_PROPERTY_TYPES, NOTE_PROPERTY_TYPES,
} from '@kinqs/brainrouter-core/notes/editing';
import {
  cellEditorFor, canDragBetweenGroups, isDerivedType, isReadOnlyProperty,
  propertyTypeLabel, DERIVED_TYPES,
  type DatabasePropertyDto,
} from './database.js';

function property(over: Partial<DatabasePropertyDto> = {}): DatabasePropertyDto {
  return { id: 'x', name: 'X', type: 'text', unsupported: false, operators: [], ...over };
}

test('every property type core offers has an editor here', () => {
  // F1's rule applied to a column: the picker lists core's types, so a type with
  // no branch in `cellEditorFor` is a column somebody can add that then renders
  // as a read-only dash with a message saying this build cannot read it — an
  // offer the product cannot honour.
  for (const type of NOTE_PROPERTY_TYPES) {
    const editor = cellEditorFor(property({ type }));
    assert.notEqual(editor, 'none', `${type} has no editor`);
  }
});

test('the derived list matches core, so the two cannot drift', () => {
  // The renderer needs to know a column is derived per cell, and the catalogue's
  // flag arrives per TYPE. Duplicating the list is the compromise; this is what
  // stops it becoming a divergence.
  assert.deepEqual([...DERIVED_TYPES].sort(), [...DERIVED_PROPERTY_TYPES].sort());
});

test('a derived column is read-only, and that is not the same as unreadable', () => {
  for (const type of DERIVED_PROPERTY_TYPES) {
    const def = property({ type });
    assert.equal(cellEditorFor(def), 'computed', `${type} draws a computed cell`);
    assert.equal(isDerivedType(type), true);
    assert.equal(isReadOnlyProperty(def), true);
  }
  // A type this build cannot read is a DIFFERENT cell: it shows the value as it
  // was stored, and says so. Collapsing the two would make every formula look
  // like a column from a newer client.
  assert.equal(cellEditorFor(property({ type: 'formula', unsupported: true })), 'none');
});

test('a files column has its own editor rather than falling through to text', () => {
  assert.equal(cellEditorFor(property({ type: 'files' })), 'files');
});

test('a card cannot be dragged onto a group whose column nothing can write', () => {
  // A board grouped by a formula that accepted a drag and silently did nothing
  // reads as the board being broken rather than as the column being derived.
  assert.equal(canDragBetweenGroups(property({ type: 'formula' })), false);
  assert.equal(canDragBetweenGroups(property({ type: 'created-time' })), false);
  assert.equal(canDragBetweenGroups(property({ type: 'select' })), true);
});

test('every type has a label a person can read', () => {
  for (const type of NOTE_PROPERTY_TYPES) {
    const label = propertyTypeLabel(type);
    assert.ok(label.length > 0);
    // The raw stored spelling is the fallback for a type from a newer client.
    // Reaching it for a type THIS build has is a missing label.
    assert.notEqual(label, type, `${type} falls through to its stored spelling`);
  }
});
