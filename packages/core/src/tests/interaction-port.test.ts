import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { withTempWorkspaceAsync } from './_helpers.js';

const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };

function portAgent(workspace: string, port: any, extra: Record<string, unknown> = {}): Agent {
  return new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
    workspaceRoot: workspace, launchCwd: workspace, silent: false, interactionPort: port, ...extra,
  } as any);
}

const runTool = (agent: Agent, name: string, args: any): Promise<string> =>
  (agent as any).executeLocalTool(name, args, [], new Map());

test('ask_user_choice answers through the interaction port (no TTY needed)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    let seen: any = null;
    const agent = portAgent(workspace, {
      confirm: async () => true,
      choice: async (req: any) => { seen = req; return ['Option B']; },
    });
    const res = JSON.parse(await runTool(agent, 'ask_user_choice', {
      question: 'Pick one', header: 'Pick',
      options: [
        { label: 'Option A', description: 'first' },
        { label: 'Option B', description: 'second' },
      ],
    }));
    assert.equal(res.answer, 'Option B');
    assert.equal(seen.question, 'Pick one');
    assert.equal(seen.options.length, 2);
  });
});

test('PARITY-Q ask_user_choice batched form asks each question and returns aggregated answers', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const asked: string[] = [];
    const agent = portAgent(workspace, {
      confirm: async () => true,
      // answer each question with its second option's label
      choice: async (req: any) => { asked.push(req.header); return [req.options[1].label]; },
    });
    const res = JSON.parse(await runTool(agent, 'ask_user_choice', {
      questions: [
        { question: 'Which runner?', header: 'Runner', options: [{ label: 'MLX', description: 'a' }, { label: 'llama.cpp', description: 'b' }] },
        { question: 'Which scope?', header: 'Scope', options: [{ label: 'Phase 1', description: 'a' }, { label: 'Full', description: 'b' }] },
      ],
    }));
    // Both questions were asked, in order; answers keyed by header.
    assert.deepEqual(asked, ['Runner', 'Scope']);
    assert.equal(res.answer, undefined, 'batched form returns `answers`, not `answer`');
    assert.equal(res.answers.Runner, 'llama.cpp');
    assert.equal(res.answers.Scope, 'Full');
  });
});

test('ask_user_choice: dismissed dialog falls back to the decide-yourself contract', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent = portAgent(workspace, { confirm: async () => true, choice: async () => null });
    await assert.rejects(
      () => runTool(agent, 'ask_user_choice', {
        question: 'Pick', header: 'P',
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      }),
      /dismissed the choice dialog/,
    );
  });
});

test('run_command ask-mode approval routes through port.confirm (approve + deny)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const calls: any[] = [];
    // silent:false → planning-mode 'ask'; the port replaces readline.
    const approveAgent = portAgent(workspace, {
      confirm: async (req: any) => { calls.push(req); return true; },
      choice: async () => null,
    }, { accessMode: 'shell' });
    const out = await runTool(approveAgent, 'run_command', { command: 'echo port-ok' });
    assert.match(out, /port-ok/);
    assert.equal(calls[0].tool, 'run_command');
    assert.match(calls[0].detail, /echo port-ok/);

    const denyAgent = portAgent(workspace, {
      confirm: async () => false, choice: async () => null,
    }, { accessMode: 'shell' });
    const denied = await runTool(denyAgent, 'run_command', { command: 'echo nope' });
    assert.match(denied, /rejected by user/);
  });
});
