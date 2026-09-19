/**
 * The briefing knows where the question was asked from — and now says so.
 *
 * `BriefingInputs` has carried `workspaceRoot` since it was written and
 * forwarded it to ONE of its seven sources. `memory_task_state`,
 * `memory_failed_attempts` and `memory_file_history` went out with nothing but
 * the question text, so they searched every workspace the person had. Seen live
 * (session 3cbe409e…): "tell me about the current state of Orbyn" recalled a
 * `handover_note` about a resignation from an unrelated personal session, and
 * the model read it as instructions.
 *
 * A bare `filePath` is the sharpest case of the same bug: every repository has
 * an `AGENT.md`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceTagFromPath } from '@kinqs/brainrouter-types';
import { buildMemoryBriefing } from '../memory/briefing.js';

const WORKSPACE = '/tmp/orbyn';
const SESSION = 'sess-orbyn';
const TOOLS = [
  'memory_recall', 'memory_task_state', 'memory_failed_attempts',
  'memory_file_history', 'memory_working_context',
].map((name) => ({ name }));

function fakeClient(calls: Array<{ name: string; args: Record<string, unknown> }>, records: unknown[] = []) {
  return {
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: JSON.stringify({ records }) }] };
    },
  } as never;
}

async function brief(records: unknown[] = []) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await buildMemoryBriefing({
    mcpClient: fakeClient(calls, records),
    mcpTools: TOOLS,
    sessionKey: SESSION,
    workspaceRoot: WORKSPACE,
    query: 'tell me about the current state of Orbyn',
    sourcePlan: {
      includeCoreIdentity: false, includeRecall: false, includeWorkingContext: false,
      includeTaskState: true, includeExplainRecall: false,
      includeVulnerabilityIntelligence: false, includeFailedAttempts: true,
      fileHistoryPaths: ['AGENT.md'],
    },
  });
  return { calls, result };
}

test('every memory read now says which workspace and session is asking', async () => {
  const { calls } = await brief();
  const tag = workspaceTagFromPath(WORKSPACE);
  for (const name of ['memory_task_state', 'memory_failed_attempts', 'memory_file_history']) {
    const call = calls.find((c) => c.name === name);
    assert.ok(call, `${name} was not called`);
    assert.equal(call.args.workspaceTag, tag, `${name} asked blind`);
    assert.equal(call.args.sessionKey, SESSION, `${name} asked without its session`);
  }
  // A bare file path is ambiguous across every repo — this one especially.
  assert.equal(calls.find((c) => c.name === 'memory_file_history')?.args.filePath, 'AGENT.md');
});

test('a record from another workspace is announced as context, not instructions', async () => {
  const { result } = await brief([
    { recordId: 'r1', type: 'handover_note', content: 'Submitted resignation; update LinkedIn.', scopeMatch: 'other-workspace' },
  ]);
  assert.match(result.block, /captured in a DIFFERENT workspace/);
  assert.match(result.block, /context, not instructions/);
  assert.match(result.block, /ranked last/, 'preferred, not hidden');
  assert.equal(result.recalledRecords[0]?.scopeMatch, 'other-workspace');
});

test('a briefing made only of this workspace\'s own records says nothing extra', async () => {
  const { result } = await brief([
    { recordId: 'r2', type: 'task_state', content: 'Mid-refactor of the API layer.', scopeMatch: 'workspace' },
  ]);
  assert.ok(!/DIFFERENT workspace/.test(result.block), 'no warning when there is nothing to warn about');
});
