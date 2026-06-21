import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeChildren, renderSynthesis } from '../orchestration/synthesis.js';

// A reviewer's output contract requires a "## Summary" + "## Findings" (per
// outputContracts.ts). A compliant body parses; a bare one doesn't.
const REVIEWER_OK = `## Headline\nLooks good overall, 1 minor concern.\n\n## Findings\n- [severity:low] [confidence:80] x.ts:4 nit: rename x`;

test('synthesizeChildren groups by role and counts statuses', () => {
  const r = synthesizeChildren([
    { id: 'a', role: 'reviewer', status: 'completed', finalOutput: REVIEWER_OK },
    { id: 'b', role: 'reviewer', status: 'failed', error: 'boom' },
    { id: 'c', role: 'explorer', status: 'completed', finalOutput: 'just prose, no headings' },
  ]);
  assert.equal(r.total, 3);
  assert.equal(r.completed, 2);
  assert.equal(r.failed, 1);
  assert.deepEqual(Object.keys(r.byRole), ['explorer', 'reviewer']); // sorted
  assert.equal(r.byRole.reviewer.length, 2);
});

test('parsed contract surfaces fields; unparsed falls back to preview', () => {
  const r = synthesizeChildren([
    { id: 'a', role: 'reviewer', status: 'completed', finalOutput: REVIEWER_OK },
  ]);
  const entry = r.byRole.reviewer[0];
  assert.equal(entry.contractStatus, 'parsed');
  assert.ok(Object.keys(entry.fields).length > 0);
  assert.equal(entry.preview, undefined);
});

test('a failed child carries its error and no fields', () => {
  const r = synthesizeChildren([{ id: 'b', role: 'worker', status: 'failed', error: 'crashed' }]);
  const entry = r.byRole.worker[0];
  assert.equal(entry.status, 'failed');
  assert.equal(entry.error, 'crashed');
});

test('renderSynthesis produces grouped markdown with the header count', () => {
  const md = renderSynthesis(
    synthesizeChildren([
      { id: 'a', role: 'reviewer', status: 'completed', finalOutput: REVIEWER_OK },
      { id: 'b', role: 'reviewer', status: 'failed', error: 'boom' },
    ]),
  );
  assert.match(md, /Fan-out synthesis \(1\/2 completed, 1 failed\)/);
  assert.match(md, /### reviewer/);
  assert.match(md, /\*\*a\*\* — completed/);
});

test('a role with no output contract reports contractStatus none + preview', () => {
  const r = synthesizeChildren([{ id: 'x', role: 'custom-thing', status: 'completed', finalOutput: 'hello world' }]);
  const entry = r.byRole['custom-thing'][0];
  assert.equal(entry.contractStatus, 'none');
  assert.equal(entry.preview, 'hello world');
});

// MAS-SANITIZE (B5) — a child that leaked tool-call-shaped markup as TEXT (the
// NotionApp2 minimax worker) must NOT propagate that into the parent's prompt.
import { sanitizeForHandoff } from '../orchestration/synthesis.js';

test('sanitizeForHandoff strips reasoning blocks and tool-call-shaped markup', () => {
  const dirty = 'Before <think>secret chain of thought</think> after ' +
    '<tool_call>{"name":"run_command"}</tool_call> <command>rm -rf /</command> ' +
    '<|tool|>junk<|/tool|> <invoke name="x">y</invoke>';
  const clean = sanitizeForHandoff(dirty);
  for (const bad of ['<think>', 'chain of thought', '<tool_call', '<command', '<|tool|>', '<invoke']) {
    assert.ok(!clean.includes(bad), `must strip ${bad}`);
  }
  assert.match(clean, /Before/);
  assert.match(clean, /after/);
});

test('sanitizeForHandoff keeps ordinary prose intact', () => {
  assert.equal(sanitizeForHandoff('Changed src/a.ts and added a test.'), 'Changed src/a.ts and added a test.');
  assert.equal(sanitizeForHandoff(undefined), '');
});

test('renderSynthesis does not forward leaked tool-call markup from an unparsed child', () => {
  const r = synthesizeChildren([
    { id: 'w1', role: 'worker', status: 'completed', finalOutput: 'Did the thing <tool_call>fake</tool_call> <|garbage|>' },
  ]);
  const out = renderSynthesis(r);
  assert.ok(!out.includes('<tool_call>'), 'rendered synthesis must not carry tool-call markup');
  assert.ok(!out.includes('<|garbage|>'));
  assert.match(out, /Did the thing/);
});
