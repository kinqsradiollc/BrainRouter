/**
 * ADR-038 — the browser-safe Notes contract and its pure policy seam.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTES_EDITING_CAPABILITIES,
  describeInstantiation,
  parseNotesMutationRequest,
  planAddDatabaseProperty,
  planCreateDatabaseRow,
  planNoteGesture,
  planSaveDatabaseView,
  resolveNoteMutationPosition,
  rollupTargetPropertiesFromBlocks,
  type NoteBlock,
} from '../notes/editing.js';

const at = { physical: 1, logical: 0, deviceId: 'test' };
const block = (
  id: string,
  text: string,
  parentId: string | null = null,
  rank = 'U',
  kind: NoteBlock['kind']['value'] = 'paragraph',
): NoteBlock => ({
  id,
  createdAt: at,
  parentId: { value: parentId, at },
  rank: { value: rank, at },
  kind: { value: kind, at },
  text: { value: text, at },
});

test('the runtime parser narrows the versioned browser mutation envelope', () => {
  const parsed = parseNotesMutationRequest({
    version: 1,
    requestId: 'request-1',
    deviceId: 'dashboard-tab',
    // Deliberately ignored by the contract: scope is host-authenticated.
    userId: 'somebody-else',
    operation: { type: 'gesture.split', blockId: 'blk_1', caret: 3, leaseEpoch: 2 },
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.operation.type, 'gesture.split');
    assert.equal('userId' in parsed.value, false, 'scope fields are stripped from the host contract');
  }
});

test('malformed and over-bound edits are refused before a host sees them', () => {
  const badVersion = parseNotesMutationRequest({
    version: 2, requestId: 'r', deviceId: 'd',
    operation: { type: 'block.delete', blockId: 'blk_1' },
  });
  assert.equal(badVersion.ok, false);

  const noDirection = parseNotesMutationRequest({
    version: 1, requestId: 'r', deviceId: 'd',
    operation: { type: 'gesture.move', blockId: 'blk_1', direction: 0 },
  });
  assert.equal(noDirection.ok, false);

  const hugeComment = parseNotesMutationRequest({
    version: 1, requestId: 'r', deviceId: 'd',
    operation: { type: 'comment.add', blockId: 'blk_1', body: 'x'.repeat(4001) },
  });
  assert.equal(hugeComment.ok, false);

  const hiddenCommentWrite = parseNotesMutationRequest({
    version: 1, requestId: 'r', deviceId: 'd',
    operation: {
      type: 'block.update', blockId: 'blk_1',
      patch: { comments: { forged: { body: 'bypassed comment policy' } } },
    },
  });
  assert.equal(hiddenCommentWrite.ok, false);

  const databasePolicyBypass = parseNotesMutationRequest({
    version: 1, requestId: 'r', deviceId: 'd',
    operation: {
      type: 'block.update', blockId: 'row_1', patch: { props: { status: 'done' } },
    },
  });
  assert.equal(databasePolicyBypass.ok, false);

  const malformedFilter = parseNotesMutationRequest({
    version: 1, requestId: 'r', deviceId: 'd',
    operation: {
      type: 'database.view.save', databaseId: 'db',
      view: { id: 'table', filter: {} },
    },
  });
  assert.equal(malformedFilter.ok, false);

  const nestedCell = parseNotesMutationRequest({
    version: 1, requestId: 'r', deviceId: 'd',
    operation: {
      type: 'database.row.set', rowId: 'row', propertyId: 'status', value: { nested: true },
    },
  });
  assert.equal(nestedCell.ok, false);

  const controlCharacter = parseNotesMutationRequest({
    version: 1, requestId: 'request\nforged', deviceId: 'd',
    operation: { type: 'block.delete', blockId: 'blk_1' },
  });
  assert.equal(controlCharacter.ok, false);

  const invalidConflictChoice = parseNotesMutationRequest({
    version: 1, requestId: 'r', deviceId: 'd',
    operation: { type: 'conflict.resolve', blockId: 'blk_1', field: 'text', keep: 'both' },
  });
  assert.equal(invalidConflictChoice.ok, false);

  const missingTemplateParent = parseNotesMutationRequest({
    version: 1, requestId: 'r', deviceId: 'd',
    operation: { type: 'template.instantiate', templateId: 'page_template' },
  });
  assert.equal(missingTemplateParent.ok, false);
});

test('inherited mutation fields are rejected and accepted operations are own-data clones', () => {
  const inherited = Object.create({ type: 'block.delete', blockId: 'victim' });
  const poisoned = parseNotesMutationRequest({
    version: 1,
    requestId: 'inherited-operation',
    deviceId: 'dashboard-tab',
    operation: inherited,
  });
  assert.equal(poisoned.ok, false);

  const accepted = parseNotesMutationRequest({
    version: 1,
    requestId: 'own-operation',
    deviceId: 'dashboard-tab',
    operation: { type: 'block.delete', blockId: 'safe-block' },
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(Object.getPrototypeOf(accepted.value.operation), null);
    assert.equal(accepted.value.operation.type, 'block.delete');
  }
});

test('capabilities are honest about remote undo and native attachment bytes', () => {
  assert.equal(NOTES_EDITING_CAPABILITIES.operations['history.state'], true);
  assert.equal(NOTES_EDITING_CAPABILITIES.operations['history.undo'], false);
  assert.equal(NOTES_EDITING_CAPABILITIES.operations['history.redo'], false);
  assert.equal(NOTES_EDITING_CAPABILITIES.operations['attachment.upload-bytes'], false);
  assert.equal(NOTES_EDITING_CAPABILITIES.operations['block.restore'], true);
  assert.equal(NOTES_EDITING_CAPABILITIES.operations['conflict.resolve'], true);
  assert.equal(NOTES_EDITING_CAPABILITIES.operations['template.instantiate'], true);
  assert.equal(NOTES_EDITING_CAPABILITIES.history.undo, false);
  assert.equal(NOTES_EDITING_CAPABILITIES.attachments.bytes, false);
});

test('a split is planned as primitive writes without reading a store', () => {
  const source = block('blk_source', 'one two');
  const plan = planNoteGesture([source], {
    type: 'split', blockId: source.id, caret: 3,
  }, {
    mintId: () => 'blk_tail',
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.steps[0], {
    type: 'update', blockId: 'blk_source', patch: { text: 'one' },
  });
  const created = plan.steps[1];
  assert.equal(created?.type, 'create');
  if (created?.type === 'create') {
    assert.equal(created.block.id, 'blk_tail');
    assert.equal(created.block.parentId, null);
    assert.equal(created.block.kind, 'paragraph');
    assert.equal(created.block.text, ' two');
    assert.ok(created.block.rank > source.rank.value);
  }
  assert.equal(plan.result.createdId, 'blk_tail');
});

test('remote placement refuses missing parents and stale sibling anchors', () => {
  const source = block('blk_source', 'one');
  assert.deepEqual(
    resolveNoteMutationPosition([source], { parentId: 'blk_missing' }),
    { ok: false, detail: 'No block blk_missing.' },
  );
  assert.deepEqual(
    resolveNoteMutationPosition([source], { after: 'blk_stale' }),
    { ok: false, detail: 'No sibling blk_stale under this parent.' },
  );
});

test('duplicate remaps references inside the copied subtree and leaves outside links alone', () => {
  const root = block('page', 'Page', null, 'U', 'page');
  const child = block(
    'child',
    'see brainrouter://notes/block/child and brainrouter://notes/block/outside',
    root.id,
  );
  const plan = planNoteGesture([root, child], {
    type: 'duplicate', blockId: root.id,
  }, {
    mintId: (id) => `copy-${id}`,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const copiedChild = plan.steps.find(
    (step) => step.type === 'create' && step.block.id === 'copy-child',
  );
  assert.equal(copiedChild?.type, 'create');
  if (copiedChild?.type === 'create') {
    assert.match(copiedChild.block.text ?? '', /notes\/block\/copy-child/);
    assert.match(copiedChild.block.text ?? '', /notes\/block\/outside/);
  }
});

test('database schema writes are planned by the same pure policy the store adapter uses', () => {
  const database = {
    ...block('db', 'Reading', null, 'U', 'database'),
    schema: { value: [{ id: 'title', name: 'Name', type: 'title' }], at },
    views: { value: [{ id: 'table', name: 'Table', kind: 'table' as const, visible: ['title'] }], at },
  };
  const plan = planAddDatabaseProperty(database, database.id, {
    id: 'status', name: 'Status', type: 'select',
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.patch.schema?.map((property) => property.id), ['title', 'status']);
  assert.deepEqual(plan.patch.views?.[0]?.visible, ['title', 'status']);
});

test('a null saved-view filter clears it while omission keeps it', () => {
  const database = {
    ...block('db', 'Reading', null, 'U', 'database'),
    schema: { value: [{ id: 'title', name: 'Name', type: 'title' as const }], at },
    views: { value: [{
      id: 'table', name: 'Table', kind: 'table' as const, visible: ['title'],
      filter: {
        combinator: 'and' as const,
        rules: [{ property: 'title', operator: 'contains' as const, value: 'draft' }],
      },
    }], at },
  };
  const parsed = parseNotesMutationRequest({
    version: 1, requestId: 'clear-filter', deviceId: 'dashboard-tab',
    operation: { type: 'database.view.save', databaseId: 'db', view: { id: 'table', filter: null } },
  });
  assert.equal(parsed.ok, true);

  const cleared = planSaveDatabaseView(database, database.id, { id: 'table', filter: null });
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.value.filter, undefined);
  const retained = planSaveDatabaseView(database, database.id, { id: 'table' });
  assert.equal(retained.ok, true);
  if (retained.ok) assert.equal(retained.value.filter?.combinator, 'and');
});

test('row creation reads whichever schema property is the title, not a hard-coded id', () => {
  const database = {
    ...block('db', 'Reading', null, 'U', 'database'),
    schema: { value: [{ id: 'name', name: 'Book', type: 'title' }], at },
    views: { value: [{ id: 'table', name: 'Table', kind: 'table' as const, visible: ['name'] }], at },
  };
  const plan = planCreateDatabaseRow(database, database.id, {
    values: { name: 'The Dispossessed' },
  });
  assert.equal(plan.ok, true);
  if (plan.ok) assert.equal(plan.value.text, 'The Dispossessed');
});

test('rollup targets follow the relation with the same pure traversal on every host', () => {
  const source = {
    ...block('db_source', 'Projects', null, 'U', 'database'),
    schema: { value: [
      { id: 'title', name: 'Name', type: 'title' as const },
      { id: 'tasks', name: 'Tasks', type: 'relation' as const },
    ], at },
    views: { value: [{ id: 'table', name: 'Table', kind: 'table' as const, visible: ['title', 'tasks'] }], at },
  };
  const sourceRow = {
    ...block('row_source', 'Release', source.id),
    props: { tasks: { value: ['brainrouter://notes/block/row_target'], at } },
  };
  const target = {
    ...block('db_target', 'Tasks', null, 'V', 'database'),
    schema: { value: [
      { id: 'title', name: 'Task', type: 'title' as const },
      { id: 'points', name: 'Points', type: 'number' as const },
    ], at },
    views: { value: [{ id: 'table', name: 'Table', kind: 'table' as const, visible: ['title', 'points'] }], at },
  };
  const targetRow = block('row_target', 'Ship', target.id);

  const outcome = rollupTargetPropertiesFromBlocks(
    [source, sourceRow, target, targetRow], source.id, 'tasks',
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value.properties.map(({ id }) => id), ['title', 'points']);
  assert.deepEqual(outcome.value.databases, [{ id: 'db_target', title: 'Tasks' }]);
});

test('template copy summaries stay in Core for local and remote hosts', () => {
  assert.equal(describeInstantiation({
    ok: true, pageId: 'page_copy', blocks: 3, rewritten: 1,
  }), 'New page from the template — 3 blocks, and 1 link inside it now point at this copy rather than at the template.');
});
