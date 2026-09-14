import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnLifecycleCoordinator } from '../agent/runtime/turnLifecycleCoordinator.js';

// Progress earns another nudge. A turn on a prose-then-tool model went:
// promise → nudge → list_dir ✓ → promise → nudge → glob_files ✓ → "Let me read
// it." — and ended there, because the preamble/promise budget (2) was spent even
// though real tool work had happened between the nudges. The budget now resets
// when tools ran since the last nudge, under a hard per-turn total.

function fakeAgent() {
  const statuses: string[] = [];
  const agent = {
    lastTurnToolCalls: 0,
    chatHistory: [] as unknown[],
    turnPathSteps: [] as unknown[],
    lastGoalTransition: undefined,
    silent: true,
    agentDepth: 1,
    sessionKey: 'test-session',
    workspaceRoot: '/tmp/none',
    recordTranscript: () => undefined,
  };
  const callbacks = { onStatusUpdate: (t: string) => statuses.push(t), onTurnStep: () => undefined };
  const coord = new TurnLifecycleCoordinator({ agent: agent as never, callbacks: callbacks as never, budgetWindow: 40, maxLoops: 40, fanOutHinted: false });
  return { agent, coord, statuses };
}

const ask = { response: { content: 'Which one do you mean?' }, spawnedChildIds: new Set<string>(), waitedChildIds: new Set<string>() } as never;

test('the promise guard budget resets after real tool progress; without progress it is spent after two', () => {
  const { agent, coord, statuses } = fakeAgent();
  const nudges = () => statuses.filter((s) => /promised-tools-then-asked/.test(s));
  // 1) promised tools at 0 calls, ran none → nudge 1/2
  coord.setPromisedToolsAtCount(0);
  assert.deepEqual(coord.evaluateTerminalGuards(ask), { action: 'continue' });
  assert.match(statuses.at(-1)!, /promised-tools-then-asked \(1\/2\)/);
  // 2) it then ran two tools (progress!), promised again at 2, ran none → the
  //    budget reset: this nudge is 1/2 again, not 2/2
  agent.lastTurnToolCalls = 2;
  coord.setPromisedToolsAtCount(2);
  assert.deepEqual(coord.evaluateTerminalGuards(ask), { action: 'continue' });
  assert.match(statuses.at(-1)!, /promised-tools-then-asked \(1\/2\)/, 'progress since the last nudge earned a fresh budget');
  // 3) no progress this time → 2/2
  coord.setPromisedToolsAtCount(2);
  assert.deepEqual(coord.evaluateTerminalGuards(ask), { action: 'continue' });
  assert.match(statuses.at(-1)!, /promised-tools-then-asked \(2\/2\)/);
  // 4) still no progress → no third nudge (the turn may end)
  coord.setPromisedToolsAtCount(2);
  try { coord.evaluateTerminalGuards(ask); } catch { /* later guards may need a fuller agent; the promise guard itself must not fire */ }
  assert.equal(nudges().length, 3);
  // 5) progress again → one more nudge is allowed (bounded by the per-turn total)
  agent.lastTurnToolCalls = 3;
  coord.setPromisedToolsAtCount(3);
  assert.deepEqual(coord.evaluateTerminalGuards(ask), { action: 'continue' });
  assert.equal(nudges().length, 4);
});

test('without progress the budget does NOT reset — two nudges, then the turn is allowed to end', () => {
  const { coord, statuses } = fakeAgent();
  coord.setPromisedToolsAtCount(0);
  coord.evaluateTerminalGuards(ask);
  coord.setPromisedToolsAtCount(0);
  coord.evaluateTerminalGuards(ask);
  assert.match(statuses.at(-1)!, /\(2\/2\)/);
  const before = statuses.length;
  coord.setPromisedToolsAtCount(0);
  try { coord.evaluateTerminalGuards(ask); } catch { /* later guards may need a fuller agent; the promise guard itself must not fire */ }
  assert.equal(statuses.filter((s) => /promised-tools-then-asked/.test(s)).length, 2, 'no third nudge without progress');
  assert.ok(statuses.length >= before);
});
