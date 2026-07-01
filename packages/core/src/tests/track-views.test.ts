import test from 'node:test';
import assert from 'node:assert/strict';
import { isSavedView, isTrackLayout } from '@kinqs/brainrouter-types';
import { ensureProject, saveView, listViews, getView, deleteView } from '../track/trackStore.js';
import { withTempWorkspace } from './_helpers.js';

test('saved views: save is upsert-by-name; list/get/delete', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const v = saveView(ws, { name: 'My bugs', layout: 'board', query: 'type = bug', filters: { priority: 'high' } });
    assert.ok(isSavedView(v));
    assert.equal(v.layout, 'board');
    assert.equal(v.query, 'type = bug');
    assert.deepEqual(v.filters, { priority: 'high' });

    // re-saving the same name updates in place (same id, no duplicate)
    const v2 = saveView(ws, { name: 'my bugs', layout: 'calendar' });
    assert.equal(v2.id, v.id);
    assert.equal(v2.layout, 'calendar');
    assert.equal(v2.query, undefined); // cleared
    assert.equal(listViews(ws).length, 1);

    // a second, distinct view (re-saving adopted the new "my bugs" casing)
    saveView(ws, { name: 'Roadmap', layout: 'gantt' });
    assert.deepEqual(listViews(ws).map((x) => x.name), ['my bugs', 'Roadmap']); // alphabetical

    assert.equal(getView(ws, 'roadmap')?.layout, 'gantt'); // by name, case-insensitive
    assert.equal(getView(ws, v.id)?.name, 'my bugs'); // by id

    assert.equal(deleteView(ws, 'MY BUGS'), true); // delete is case-insensitive too
    assert.equal(getView(ws, 'my bugs'), undefined);
    assert.equal(listViews(ws).length, 1);
    assert.equal(deleteView(ws, 'My bugs'), false);
  });
});

test('saved views: layout guard', () => {
  assert.ok(isTrackLayout('spreadsheet') && isTrackLayout('gantt') && isTrackLayout('calendar'));
  assert.ok(!isTrackLayout('timeline'));
});
