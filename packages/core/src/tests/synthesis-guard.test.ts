import test from 'node:test';
import assert from 'node:assert/strict';
import { isChildSynthesisTool, resultHasChildOutput, looksLikeChildSynthesisPunt } from '../util/agentloop/synthesisGuard.js';

test('MAR-3 isChildSynthesisTool: child-result tools only', () => {
  for (const n of ['task_agent', 'wait_agent', 'wait_agents', 'delegate_explorer', 'delegate_reviewer']) {
    assert.equal(isChildSynthesisTool(n), true, n);
  }
  for (const n of ['spawn_agent', 'spawn_agents', 'read_file', 'grep_search', 'route_task']) {
    assert.equal(isChildSynthesisTool(n), false, n);
  }
});

test('MAR-3 resultHasChildOutput: detects real child output, ignores metadata/junk', () => {
  assert.equal(resultHasChildOutput(JSON.stringify({ id: 'a', finalOutput: 'Found 3 issues...' })), true);
  assert.equal(resultHasChildOutput(JSON.stringify({ agents: [{ id: 'a', finalOutput: 'x' }, { id: 'b' }] })), true);
  assert.equal(resultHasChildOutput(JSON.stringify({ id: 'a', contract: { findings: [] } })), true);
  // background spawn returns running metadata only → no output yet
  assert.equal(resultHasChildOutput(JSON.stringify({ id: 'a', status: 'running' })), false);
  // empty finalOutput doesn't count
  assert.equal(resultHasChildOutput(JSON.stringify({ id: 'a', finalOutput: '   ' })), false);
  // non-JSON / garbage
  assert.equal(resultHasChildOutput('not json'), false);
  assert.equal(resultHasChildOutput(''), false);
});

test('MAR-3 looksLikeChildSynthesisPunt: flags short deferrals, spares real syntheses', () => {
  assert.equal(looksLikeChildSynthesisPunt("I've launched an exploration agent and I will summarize the findings when complete."), true);
  assert.equal(looksLikeChildSynthesisPunt('The agent is still working through the codebase. I will notify you when it finishes.'), true);
  assert.equal(looksLikeChildSynthesisPunt("I'll report back once the analysis is complete."), true);
  // a real synthesis (no deferral phrasing) is not flagged
  assert.equal(looksLikeChildSynthesisPunt('The audit found 3 issues: (1) missing auth on /users, (2) ... (3) ...'), false);
  // empty / whitespace
  assert.equal(looksLikeChildSynthesisPunt(''), false);
  // a long answer is assumed to be a genuine synthesis even if it mentions "summarize"
  const long = 'Here is the full summary of what the agent found. '.repeat(40) + " I will summarize later.";
  assert.equal(looksLikeChildSynthesisPunt(long), false);
});
