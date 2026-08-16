/**
 * ADR-028 H2 — the argv is built in ONE place.
 *
 * The route was already decided once; the command was not. `gh stack link`
 * shipped and survived a ten-code exit contract, a latching runner and fourteen
 * tests, because an unknown subcommand exits 1 exactly like a real command that
 * failed. Nothing downstream can catch an invented verb — only single-sourcing
 * the argv can.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeRequestArgv, changeRequestTimeoutMs, type PrRoute } from '../review/prRouter.js';

const stack: PrRoute = { kind: 'stack', reason: 'x' };
const single: PrRoute = { kind: 'single', reason: 'x' };
const ARGS = { title: 'T', body: 'B' };

/** Verified against `gh stack --help`. `submit` is the only one we ever run. */
const REAL_STACK_SUBCOMMANDS = new Set(['init', 'add', 'submit', 'view', 'sync', 'merge', 'rebase']);

test('a stacked route publishes the chain with a REAL subcommand', () => {
  const argv = changeRequestArgv(stack, ARGS);
  assert.equal(argv[0], 'stack');
  assert.ok(REAL_STACK_SUBCOMMANDS.has(argv[1]!), `"gh stack ${argv[1]}" is not a real subcommand`);
  assert.ok(argv.includes('--auto'), 'without --auto the PRs are not linked into a stack');
});

test('a single route creates a draft pull request', () => {
  const argv = changeRequestArgv(single, ARGS);
  assert.deepEqual(argv.slice(0, 3), ['pr', 'create', '--draft']);
  assert.ok(argv.includes('--title'));
  assert.ok(argv.includes('--body'));
});

test('ready drops the draft flag on one route and opens on the other', () => {
  assert.ok(!changeRequestArgv(single, { ...ARGS, ready: true }).includes('--draft'));
  assert.ok(changeRequestArgv(stack, { ...ARGS, ready: true }).includes('--open'));
});

test('a base branch is passed only where it means something', () => {
  const argv = changeRequestArgv(single, { ...ARGS, baseBranch: 'release/0.4.20' });
  assert.deepEqual(argv.slice(-6, -4), ['--base', 'release/0.4.20']);
  // A stack submit takes its base from the stack, not from a flag — passing one
  // would be an invented option, which is the failure this file exists for.
  assert.ok(!changeRequestArgv(stack, { ...ARGS, baseBranch: 'main' }).includes('--base'));
});

test('a stack submit gets a budget a chain can finish in', () => {
  // 20s is a plain create's budget; publishing a chain pushes every branch and
  // opens every PR, so the short timeout would report a working submit failed.
  assert.ok(changeRequestTimeoutMs(stack) >= 60_000);
  assert.ok(changeRequestTimeoutMs(single) < changeRequestTimeoutMs(stack));
});
