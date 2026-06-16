import test from 'node:test';
import assert from 'node:assert/strict';
import { addOpened, bumpActivity } from './recents.js';
const A = '/w/a', B = '/w/b', C = '/w/c';
test('opening a project that is already present does NOT reorder it', () => {
    // A is below B; "opening" A must keep A below B (the bug: it jumped to top).
    assert.deepEqual(addOpened([B, A], A), [B, A]);
});
test('opening a NEW project adds it at the bottom (no promotion)', () => {
    assert.deepEqual(addOpened([B, A], C), [B, A, C]);
});
test('opening is idempotent', () => {
    assert.deepEqual(addOpened([A, B], A), [A, B]);
});
test('activity promotes a project to the top', () => {
    assert.deepEqual(bumpActivity([B, A, C], C, 10), [C, B, A]);
    assert.deepEqual(bumpActivity([B, A], A), [A, B]);
});
test('activity on a brand-new project puts it first', () => {
    assert.deepEqual(bumpActivity([A, B], C), [C, A, B]);
});
test('bumpActivity dedupes and caps', () => {
    assert.deepEqual(bumpActivity([A, A, B], A, 2), [A, B]);
    assert.equal(bumpActivity(['1', '2', '3', '4'], '5', 3).length, 3);
});
test('addOpened never drops the just-opened project when over cap', () => {
    const full = ['1', '2', '3'];
    const out = addOpened(full, A, 3);
    assert.ok(out.includes(A), 'the opened project is present');
    assert.equal(out.length, 3);
    assert.equal(out[out.length - 1], A, 'opened lands at the bottom');
});
test('REGRESSION: opening A then B then viewing A keeps activity order (B above A) — opening A again must not promote it', () => {
    let list = [];
    list = addOpened(list, A); // open A
    list = addOpened(list, B); // open B
    list = bumpActivity(list, B, 10); // B gets activity → top
    assert.deepEqual(list, [B, A]);
    list = addOpened(list, A); // merely view/open A again
    assert.deepEqual(list, [B, A], 'viewing A did not move it above B');
});
