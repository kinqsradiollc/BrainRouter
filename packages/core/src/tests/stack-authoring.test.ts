/**
 * ADR-028 S2-2 — the create path.
 *
 * The property that matters most: creating a layer means `gh stack add` THEN
 * `gh stack submit`. The removed implementation (A2) made one `gh api pulls`
 * call, which produces a pull request that merely targets the branch below —
 * indistinguishable in the UI, and missing every behaviour the feature exists
 * for. These tests pin the two-step so the shortcut cannot come back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addStackLayer,
  linkExistingIntoStack,
  validateLayerRequest,
  canAddLayer,
  DEFAULT_MAX_STACK_DEPTH,
  isSafeArgument,
} from '../review/stackAuthoring.js';
import { StackRunner, type StackExec } from '../review/stackRunner.js';
import type { StackCapability } from '../review/stackCapability.js';

const AVAILABLE: StackCapability = {
  available: true, ghVersion: 'gh 2.91.0', gitVersion: 'git 2.39.5', extensionInstalled: true,
};

function exec(codes: number[] | number): StackExec & { calls: string[][] } {
  const queue = Array.isArray(codes) ? [...codes] : [codes];
  const calls: string[][] = [];
  const fn = (async (args: readonly string[]) => {
    calls.push([...args]);
    const exitCode = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { exitCode, stdout: '', stderr: '' };
  }) as StackExec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const REQUEST = {
  branch: 'feat/api-layer',
  title: 'Add the read endpoint',
  body: 'This reads the schema added in the layer below; it cannot compile without it.',
};

test('creating a layer runs `stack add` THEN `stack submit` — not a plain PR create', async () => {
  // The entire point of S2-2. One API call cannot produce a stacked PR.
  const e = exec(0);
  const result = await addStackLayer(new StackRunner({ exec: e, capability: AVAILABLE }), REQUEST);
  assert.equal(result.created, true);
  assert.deepEqual(e.calls[0], ['stack', 'add', '--', 'feat/api-layer']);
  assert.equal(e.calls[1]![1], 'submit');
});

test('a failed submit reports WHICH half succeeded', async () => {
  // The branch exists, the PR does not. A human recovering from this needs to
  // know that, or they re-create a branch that is already there.
  const e = exec([0, 4]);
  const result = await addStackLayer(new StackRunner({ exec: e, capability: AVAILABLE }), REQUEST);
  assert.equal(result.created, false);
  assert.match((result as { reason: string }).reason, /branch "feat\/api-layer" was created/);
  assert.match((result as { reason: string }).reason, /re-run submit/);
});

test('a failed add does not attempt submit', async () => {
  const e = exec([3, 0]);
  const result = await addStackLayer(new StackRunner({ exec: e, capability: AVAILABLE }), REQUEST);
  assert.equal(result.created, false);
  assert.equal(e.calls.length, 1, 'submitting a branch that was not created is nonsense');
});

test('a body that does not state the dependency is refused before anything runs', async () => {
  // A7: each layer must be reviewable alone, and that requires prose saying what
  // it builds on. Refusing at the boundary beats a reviewer discovering it.
  const e = exec(0);
  const result = await addStackLayer(
    new StackRunner({ exec: e, capability: AVAILABLE }),
    { ...REQUEST, body: 'Layer 3 of 5' },
  );
  assert.equal(result.created, false);
  assert.equal(e.calls.length, 0);
});

test('validation catches the branch names git would reject', () => {
  assert.equal(validateLayerRequest(REQUEST), null);
  assert.match(validateLayerRequest({ ...REQUEST, branch: 'has spaces' })!, /not a usable branch/);
  assert.match(validateLayerRequest({ ...REQUEST, branch: '' })!, /branch name is required/);
  assert.match(validateLayerRequest({ ...REQUEST, title: '  ' })!, /title is required/);
});

test('linking fewer than two pull requests is refused', () => {
  // One PR is not a stack, and `gh stack link` would take it.
  return linkExistingIntoStack(new StackRunner({ exec: exec(0), capability: AVAILABLE }), ['#1'])
    .then((r) => {
      assert.equal(r.linked, false);
      assert.match(r.reason!, /at least two/);
    });
});

test('linking passes every ref through in order', async () => {
  const e = exec(0);
  const r = await linkExistingIntoStack(
    new StackRunner({ exec: e, capability: AVAILABLE }),
    ['#1', '#2', '#3'],
    'main',
  );
  assert.equal(r.linked, true);
  assert.deepEqual(e.calls[0], ['stack', 'link', '--base', 'main', '--', '#1', '#2', '#3']);
});

test('a layer is never added on top of a base that failed its checks', () => {
  // Anything above a broken layer cannot merge, so building further only
  // produces work that is blocked by construction.
  const blocked = canAddLayer({ currentDepth: 1, baseLayerReady: false });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /cannot merge/);
});

test('depth is capped, and the cap explains itself', () => {
  assert.equal(canAddLayer({ currentDepth: 1, baseLayerReady: true }).allowed, true);
  const deep = canAddLayer({ currentDepth: DEFAULT_MAX_STACK_DEPTH, baseLayerReady: true });
  assert.equal(deep.allowed, false);
  assert.match(deep.reason!, /becomes a queue/);
  // The cap is a default, not a law — a team that wants deeper stacks can say so.
  assert.equal(canAddLayer({ currentDepth: 6, baseLayerReady: true, maxDepth: 10 }).allowed, true);
});

/* ----------------------------------------- argument-injection boundary */

test('a hyphen-leading branch name is REFUSED — gh would read it as an option', () => {
  // The original regex looked restrictive but matched `--force` and `-h`, which
  // `gh stack add` parses as options rather than as the branch they were meant
  // to be. Branch names come from agent-produced plan data, so this is a real
  // boundary.
  for (const bad of ['--force', '-h', '-c']) {
    assert.match(validateLayerRequest({ ...REQUEST, branch: bad })!, /not a usable branch/);
  }
});

test('git-invalid branch shapes are refused too', () => {
  for (const bad of ['feat/a..b', 'feat/x.lock', 'has space', '']) {
    assert.equal(isSafeArgument(bad), false, `${bad} must be refused`);
  }
  for (const good of ['feat/api-layer', 'release/0.4.20', '#41', 'main']) {
    assert.equal(isSafeArgument(good), true, `${good} must be allowed`);
  }
});

test('the create path passes `--` so a positional can never be read as an option', () => {
  // Defence in depth: even if the guard is loosened later, `gh` stops parsing
  // options at `--`.
  const e = exec(0);
  return addStackLayer(new StackRunner({ exec: e, capability: AVAILABLE }), REQUEST).then(() => {
    assert.deepEqual(e.calls[0], ['stack', 'add', '--', 'feat/api-layer']);
  });
});

test('linking refuses option-shaped refs before running anything', async () => {
  const e = exec(0);
  const r = await linkExistingIntoStack(
    new StackRunner({ exec: e, capability: AVAILABLE }),
    ['#1', '--version'],
  );
  assert.equal(r.linked, false);
  assert.match(r.reason!, /read as a command-line option/);
  assert.equal(e.calls.length, 0, 'nothing may run with an unsafe ref');
});

test('linking refuses an option-shaped base', async () => {
  const e = exec(0);
  const r = await linkExistingIntoStack(
    new StackRunner({ exec: e, capability: AVAILABLE }),
    ['#1', '#2'],
    '--exec=whoami',
  );
  assert.equal(r.linked, false);
  assert.equal(e.calls.length, 0);
});
