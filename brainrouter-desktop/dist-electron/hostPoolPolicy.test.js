import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPool, planActivate, applyActivate, setRunning, removeEntry, runningRoots, DEFAULT_IDLE_TTL_MS, } from './hostPoolPolicy.js';
const A = '/work/alpha';
const B = '/work/beta';
const C = '/work/gamma';
/** Convenience: activate a workspace and fold the result into new state. */
function activate(state, root, now, ttl = DEFAULT_IDLE_TTL_MS) {
    const plan = planActivate(state, root, now, ttl);
    return { plan, state: applyActivate(state, plan, now) };
}
test('activating a fresh workspace spawns a host and makes it active', () => {
    const { plan, state } = activate(emptyPool(), A, 1_000);
    assert.equal(plan.mode, 'spawn');
    assert.deepEqual(plan.reap, []);
    assert.equal(state.activeRoot, A);
    assert.equal(state.entries.length, 1);
});
test('THE BUG: switching A→B while A is running does NOT kill A', () => {
    let s = activate(emptyPool(), A, 1_000).state;
    s = setRunning(s, A, true); // a turn is in flight in A
    const { plan, state } = activate(s, B, 2_000);
    assert.equal(plan.mode, 'spawn', 'B is new → spawn');
    assert.deepEqual(plan.reap, [], 'A must NOT be reaped: it is running');
    const a = state.entries.find((e) => e.workspaceRoot === A);
    assert.ok(a, 'A is still in the pool');
    assert.equal(a.running, true, 'A keeps running in the background');
    assert.equal(state.activeRoot, B);
});
test('switching back to A reuses its host (work intact, no respawn)', () => {
    let s = activate(emptyPool(), A, 1_000).state;
    s = setRunning(s, A, true);
    s = activate(s, B, 2_000).state;
    const { plan } = activate(s, A, 3_000);
    assert.equal(plan.mode, 'reuse', 'A already has a host → reuse it');
    assert.deepEqual(plan.reap, []);
});
test('the active host is never reaped, however old its idle clock', () => {
    // A active with an ancient lastActiveAt; re-activating something requires it gone? No — active is excluded.
    let s = activate(emptyPool(), A, 0).state;
    // Re-activate A far in the future — it is the active AND the incoming, never reaped.
    const { plan } = activate(s, A, 10 * DEFAULT_IDLE_TTL_MS);
    assert.deepEqual(plan.reap, []);
});
test('a running host is never reaped even when long idle and non-active', () => {
    let s = activate(emptyPool(), A, 0).state; // A active@0
    s = setRunning(s, A, true);
    s = activate(s, B, 1_000).state; // leave A (running) at t=1000, B active
    // Far in the future, activate C: A has been idle-by-clock forever BUT is running.
    const { plan } = activate(s, C, 1_000 + 100 * DEFAULT_IDLE_TTL_MS);
    assert.ok(!plan.reap.includes(A), 'running A survives regardless of age');
});
test('a workspace you just left is given a full TTL before it can be reaped', () => {
    let s = activate(emptyPool(), A, 0).state; // active@0 (ancient when we leave it)
    // Switch to B much later — A is the OUTGOING active, must not be reaped this tick.
    const r = activate(s, B, 100 * DEFAULT_IDLE_TTL_MS);
    assert.deepEqual(r.plan.reap, [], 'just-left A is not reaped');
    // A's idle clock restarted at the switch moment.
    const a = r.state.entries.find((e) => e.workspaceRoot === A);
    assert.equal(a.lastActiveAt, 100 * DEFAULT_IDLE_TTL_MS);
    // A short hop later, A is still fresh → still safe.
    const soon = activate(r.state, C, 100 * DEFAULT_IDLE_TTL_MS + 1_000);
    assert.deepEqual(soon.plan.reap, []);
});
test('an idle, non-active, non-running host is reaped once past the TTL', () => {
    let s = activate(emptyPool(), A, 0).state; // A active@0
    s = activate(s, B, 1_000).state; // leave A at 1_000 (idle clock starts), B active
    // Activate C well past A's TTL — A is idle, not active, not running → reap.
    const { plan, state } = activate(s, C, 1_000 + DEFAULT_IDLE_TTL_MS + 1);
    assert.deepEqual(plan.reap, [A]);
    assert.ok(!state.entries.some((e) => e.workspaceRoot === A), 'A removed from pool');
    assert.ok(state.entries.some((e) => e.workspaceRoot === B));
    assert.ok(state.entries.some((e) => e.workspaceRoot === C));
});
test('removeEntry drops an exited host and clears active if it was active', () => {
    let s = activate(emptyPool(), A, 0).state;
    s = removeEntry(s, A);
    assert.equal(s.entries.length, 0);
    assert.equal(s.activeRoot, null);
});
test('runningRoots reports background work excluding the viewed workspace', () => {
    let s = activate(emptyPool(), A, 0).state;
    s = setRunning(s, A, true);
    s = activate(s, B, 1_000).state;
    s = setRunning(s, B, true);
    assert.deepEqual(runningRoots(s, B).sort(), [A], 'A runs in the background while viewing B');
    assert.deepEqual(runningRoots(s).sort(), [A, B].sort());
});
