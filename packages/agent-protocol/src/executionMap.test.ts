/**
 * ADR-040 A40-4 — the execution map's vocabulary.
 *
 * These pin the properties whose absence is invisible in a passing run: a
 * resurrected terminal status looks like an ordinary running execution, and a
 * collapsed occurrence identity looks like a clean retry with no failure before
 * it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_EXECUTION_STATUSES,
  TERMINAL_EXECUTION_STATUSES,
  isOpenExecutionStatus,
  isTerminalExecutionStatus,
  isExecutionStatus,
  isNodeOccurrenceStatus,
  canTransitionExecutionStatus,
  boundLabel,
  boundReasonCodes,
  occurrenceKey,
  emptyExecutionUsage,
  EXECUTION_MAP_BOUNDS,
  type ExecutionStatus,
} from './executionMap.js';

test('the status vocabulary is closed and the two halves do not overlap', () => {
  for (const s of OPEN_EXECUTION_STATUSES) {
    assert.equal(isOpenExecutionStatus(s), true);
    assert.equal(isTerminalExecutionStatus(s), false, `${s} must not be terminal`);
  }
  for (const s of TERMINAL_EXECUTION_STATUSES) {
    assert.equal(isTerminalExecutionStatus(s), true);
    assert.equal(isOpenExecutionStatus(s), false, `${s} must not be open`);
  }
  assert.equal(isExecutionStatus('nonsense'), false);
});

test('`skipped` is an occurrence status only, never a run status', () => {
  // A run cannot be "skipped" — something either ran or it did not exist.
  assert.equal(isNodeOccurrenceStatus('skipped'), true);
  assert.equal(isExecutionStatus('skipped'), false);
});

test('a terminal execution never returns to running', () => {
  // This is the guard against a late or replayed event resurrecting a finished
  // run, which is how a failed execution comes back as `running` and never ends.
  for (const terminal of TERMINAL_EXECUTION_STATUSES) {
    for (const open of OPEN_EXECUTION_STATUSES) {
      assert.equal(
        canTransitionExecutionStatus(terminal, open),
        false,
        `${terminal} -> ${open} must be refused`,
      );
    }
    assert.equal(canTransitionExecutionStatus(terminal, terminal), true, 'idempotent replay is fine');
  }
});

test('a terminal execution cannot be rewritten to a DIFFERENT terminal state', () => {
  // Otherwise a late event turns a cancelled run into a succeeded one, which is
  // the version a person would then believe.
  assert.equal(canTransitionExecutionStatus('failed', 'succeeded'), false);
  assert.equal(canTransitionExecutionStatus('cancelled', 'failed'), false);
});

test('an open execution can still move anywhere legal', () => {
  const legal: ExecutionStatus[] = ['running', 'waiting-approval', 'succeeded', 'failed'];
  for (const to of legal) {
    assert.equal(canTransitionExecutionStatus('planned', to), true);
  }
});

test('occurrence identity separates attempts, and nested iterations do not collapse', () => {
  // A retry must not share identity with the attempt it replaces, or the map
  // shows a green node and loses the failure that caused the retry.
  assert.notEqual(occurrenceKey('n1', 1, []), occurrenceKey('n1', 2, []));
  // Two different positions in nested loops must not claim the same identity.
  assert.notEqual(occurrenceKey('n1', 1, [0, 1]), occurrenceKey('n1', 1, [1, 0]));
  assert.equal(occurrenceKey('n1', 1, [2, 3]), occurrenceKey('n1', 1, [2, 3]), 'stable');
  assert.equal(occurrenceKey('n1', 1, []), 'n1#1');
  assert.equal(occurrenceKey('n1', 2, [0, 4]), 'n1#2@0.4');
});

test('an iteration path is bounded so one runaway loop cannot grow a key forever', () => {
  const deep = Array.from({ length: 40 }, (_, i) => i);
  const key = occurrenceKey('n', 1, deep);
  const segments = key.split('@')[1]?.split('.') ?? [];
  assert.equal(segments.length, EXECUTION_MAP_BOUNDS.maxIterationPathDepth);
});

test('a bounded label cannot become two rows, and is clamped', () => {
  // This text renders in a list. A newline in it reads as an extra run.
  assert.equal(boundLabel('build\nthe\nthing'), 'build the thing');
  assert.equal(boundLabel('tab\there'), 'tab here');
  assert.equal(boundLabel('  spaced  out  '), 'spaced out');
  const long = 'x'.repeat(400);
  const bounded = boundLabel(long);
  assert.equal(bounded.length, EXECUTION_MAP_BOUNDS.maxBoundedLabelChars);
  assert.ok(bounded.endsWith('…'), 'truncation is visible rather than silent');
});

test('a line separator cannot survive into a label either', () => {
  // U+2028/U+2029 are line breaks that a naive \n filter misses entirely.
  assert.equal(boundLabel('a b'), 'a b');
  assert.equal(boundLabel('a b'), 'a b');
});

test('reason codes are bounded in count and width', () => {
  const many = Array.from({ length: 50 }, (_, i) => `code_${i}`);
  assert.equal(boundReasonCodes(many).length, EXECUTION_MAP_BOUNDS.maxReasonCodes);

  const wide = boundReasonCodes(['y'.repeat(500)]);
  assert.equal(wide[0]!.length, EXECUTION_MAP_BOUNDS.maxReasonCodeChars);

  assert.deepEqual(boundReasonCodes(['  ', '', 'ok']), ['ok'], 'blank codes are dropped');
});

test('empty usage is zeroed, so callers do not each spell it differently', () => {
  assert.deepEqual(emptyExecutionUsage(), {
    promptTokens: 0, completionTokens: 0, toolCalls: 0, wallClockMs: 0,
  });
});
