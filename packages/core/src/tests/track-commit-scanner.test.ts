import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureProject, createWorkItem, getWorkItem, transitionWorkItem } from '../track/trackStore.js';
import { parseCommitKeys, scanCommitsForTrack } from '../track/git/commitScanner.js';
import { withTempWorkspace } from './_helpers.js';

test('parseCommitKeys: strict <KEY>-<n>, deduped, normalized, boundary-safe', () => {
  assert.deepEqual(parseCommitKeys('fix(rate): handle BR-12 and BR-7', 'BR'), ['BR-12', 'BR-7']);
  assert.deepEqual(parseCommitKeys('BR-3 done; see also br-3 and BR-003', 'BR'), ['BR-3']); // case-insensitive + numeric dedup
  assert.deepEqual(parseCommitKeys('refs ABR-1 and XBR-9', 'BR'), []); // word boundary — no false prefix match
  assert.deepEqual(parseCommitKeys('plain 123 commit', 'BR'), []); // bare number doesn't match
  assert.deepEqual(parseCommitKeys('', 'BR'), []);
});

test('commit scanner: links a commit to its work item + advances todo → in-progress', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const w = createWorkItem(ws, { title: 'Rate limiting', status: 'todo' });
    assert.equal(w.statusCategory, 'unstarted');

    const r = scanCommitsForTrack(ws, [{ sha: 'abc1234', subject: `feat: rate limiter (${w.key})` }]);
    assert.equal(r.linked.length, 1);
    assert.deepEqual(r.linked[0], { sha: 'abc1234', key: w.key, workItemKey: w.key });
    assert.equal(r.transitioned.length, 1);

    const after = getWorkItem(ws, w.key)!;
    assert.equal(after.statusCategory, 'started');
    assert.ok(after.codeLinks.some((c) => c.kind === 'commit' && c.ref === 'abc1234'));
  });
});

test('commit scanner: idempotent — re-scanning the same commit is a no-op', () => {
  withTempWorkspace((ws) => {
    ensureProject(ws, { key: 'BR' });
    const w = createWorkItem(ws, { title: 'X', status: 'todo' });
    const commits = [{ sha: 'sha1', subject: `${w.key} work` }];
    scanCommitsForTrack(ws, commits);
    const second = scanCommitsForTrack(ws, commits);
    assert.equal(second.linked.length, 0, 're-link is skipped');
    assert.equal(second.transitioned.length, 0, 'already in-progress');
    assert.equal(getWorkItem(ws, w.key)!.codeLinks.filter((c) => c.ref === 'sha1').length, 1, 'no duplicate codeLink');
  });
});

test('commit scanner: does not move a done item back, and ignores unknown keys', () => {
  withTempWorkspace((ws) => {
    const project = ensureProject(ws, { key: 'BR' });
    const done = project.workflowStates.find((s) => s.category === 'completed')!;
    const w = createWorkItem(ws, { title: 'Shipped', status: 'todo' });
    transitionWorkItem(ws, w.key, done.id);

    const r = scanCommitsForTrack(ws, [
      { sha: 's1', subject: `${w.key} a late commit` },
      { sha: 's2', subject: 'BR-999 references a non-existent item' },
    ]);
    // The completed item still gets the commit linked (provenance) but is NOT moved.
    assert.equal(getWorkItem(ws, w.key)!.statusCategory, 'completed');
    assert.equal(r.transitioned.length, 0);
    assert.ok(r.linked.some((l) => l.key === w.key));
    assert.ok(!r.linked.some((l) => l.key === 'BR-999'));
  });
});
