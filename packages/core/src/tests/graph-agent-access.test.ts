/**
 * ADR-040 A40-3 — a saved graph's `agent` node cannot escalate persona/tool access.
 *
 * The node's declared role/access is UNTRUSTED config. `resolveGraphAgentAccess`
 * validates it fail-closed (a bogus access is dropped, never misread as a grant),
 * and whatever survives is only a REQUEST — `clampAccess` still ceilings it at the
 * parent's access, so the two together are what make escalation impossible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGraphAgentAccess, clampAccess } from '../orchestration/tools/helpers.js';

test('a valid declared access is surfaced as a request', () => {
  assert.deepEqual(resolveGraphAgentAccess({ data: { access: 'write' } }), { access: 'write' });
  assert.deepEqual(resolveGraphAgentAccess({ data: { access: 'shell' } }), { access: 'shell' });
  assert.deepEqual(resolveGraphAgentAccess({ data: { access: 'read' } }), { access: 'read' });
});

test('a bogus access is DROPPED (fail-closed), never misread as a grant', () => {
  for (const bad of ['admin', 'root', 'ADMIN', 'Write', '', 'readwrite', 42, true, null, {}]) {
    assert.deepEqual(
      resolveGraphAgentAccess({ data: { access: bad as unknown } }),
      {},
      `access ${JSON.stringify(bad)} must not leak through`,
    );
  }
});

test('role is trimmed when a non-empty string, dropped otherwise', () => {
  assert.deepEqual(resolveGraphAgentAccess({ data: { role: '  reviewer  ' } }), { role: 'reviewer' });
  assert.deepEqual(resolveGraphAgentAccess({ data: { role: '   ' } }), {});
  assert.deepEqual(resolveGraphAgentAccess({ data: { role: 99 as unknown } }), {});
});

test('role and access together; missing node or data yields nothing', () => {
  assert.deepEqual(resolveGraphAgentAccess({ data: { role: 'builder', access: 'write' } }), { role: 'builder', access: 'write' });
  assert.deepEqual(resolveGraphAgentAccess(undefined), {});
  assert.deepEqual(resolveGraphAgentAccess({}), {});
});

test('the escalation guarantee: a shell-requesting node is clamped to a read parent', () => {
  const requested = resolveGraphAgentAccess({ data: { access: 'shell' } }).access!;
  assert.equal(requested, 'shell', 'the node asked for shell');
  assert.equal(clampAccess('read', requested), 'read', 'but a read-only launch ceilings it at read');
  // And a node that asks for less than it could have still gets exactly that.
  assert.equal(clampAccess('shell', resolveGraphAgentAccess({ data: { access: 'read' } }).access!), 'read');
});
