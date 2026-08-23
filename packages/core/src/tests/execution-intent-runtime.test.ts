import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../agent/agent.js';
import { saveWorkflowGraph } from '../workflow/graph/graphStore.js';
import { createWorkspaceManifest, saveWorkspaceManifest } from '../workspace/manifest.js';
import { addHook } from '../hooks/hooksStore.js';
import { getStateFile } from '../storage/store.js';
import { handleSpawn } from '../orchestration/tools/spawn.js';
import { captureReviewedExecutionPolicy } from '../orchestration/execution/policySnapshot.js';
import type { AgentDefinition } from '../orchestration/agents/agentDefinitionFile.js';
import { writePreferences } from '../session/preferences/preferencesStore.js';
import { setSessionMode } from '../session/state/sessionModeStore.js';
import {
  registerExtensionHook,
  registerExtensionPhaseHook,
  resetExtensionContributions,
} from '../extension/registry.js';
import { setGoal } from '../goal/store/goalStore.js';
import { readRun } from '../workflow/run/workflowRun.js';
import { workspaceManifestPath } from '../workspace/manifest.js';
import {
  _resetCliKnobsCache,
  saveConfig,
  setCliKnobOverride,
} from '../config/config.js';
import { withTempWorkspaceAsync } from './_helpers.js';

function makeStubMcp(): any {
  return {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [{ text: '{}' }] }),
    close: async () => {},
  };
}

function makeMutableStubMcp(): { client: any; tools: any[] } {
  const state = {
    tools: [] as any[],
    client: undefined as any,
  };
  state.client = {
    listTools: async () => ({ tools: state.tools }),
    callTool: async () => ({ content: [{ text: '{}' }] }),
    close: async () => {},
  };
  return state;
}

function stubToolTurn(
  toolName: 'run_workflow' | 'run_workflow_graph',
  args: Record<string, unknown>,
): { restore(): void; advertised: string[][] } {
  const originalFetch = globalThis.fetch;
  const advertised: string[][] = [];
  let mainCall = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      tools?: Array<{ function?: { name?: string }; name?: string }>;
    };
    const toolNames = (body.tools ?? []).map((tool) => (
      tool.function?.name ?? tool.name ?? ''
    ));
    if (toolNames.length === 0) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"strategy":"answer-direct","reasoning":"direct","subtasks":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    advertised.push(toolNames);
    const message = mainCall === 0
      ? {
        content: '',
        tool_calls: [{
          id: 'call_intent',
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        }],
      }
      : { content: 'done' };
    mainCall += 1;
    return new Response(JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return {
    advertised,
    restore() { globalThis.fetch = originalFetch; },
  };
}

function stubToolBatchTurn(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): { restore(): void; advertised: string[][] } {
  const originalFetch = globalThis.fetch;
  const advertised: string[][] = [];
  let mainCall = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      tools?: Array<{ function?: { name?: string }; name?: string }>;
    };
    const toolNames = (body.tools ?? []).map((tool) => (
      tool.function?.name ?? tool.name ?? ''
    ));
    if (toolNames.length === 0) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"strategy":"answer-direct","reasoning":"direct","subtasks":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    advertised.push(toolNames);
    const message = mainCall === 0
      ? {
          content: '',
          tool_calls: calls.map((call, index) => ({
            id: `call_batch_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }
      : { content: 'done' };
    mainCall += 1;
    return new Response(JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return {
    advertised,
    restore() { globalThis.fetch = originalFetch; },
  };
}

/**
 * Await `promise`, but reject with a named reason if it has not settled in
 * `ms`. A test that hangs on an unresolved promise takes the whole FILE down
 * with it under node:test; a test that fails says which condition never held.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Deliberately NOT unref'd: an unref'd timer does not hold the event loop
    // open, so the loop would still drain and cancel the file before the
    // deadline could fire — which is the exact failure this guard exists to
    // convert into a message.
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${reason}`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function stubReviewedTurnWithDelayedCompletion(
  args: Record<string, unknown>,
): {
  completionStarted: Promise<void>;
  releaseCompletion(): void;
  restore(): void;
} {
  const originalFetch = globalThis.fetch;
  let launchSent = false;
  let releaseCompletion!: () => void;
  let markCompletionStarted!: () => void;
  const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  const completionStarted = new Promise<void>((resolve) => { markCompletionStarted = resolve; });
  // `completionStarted` only settles if the stub below sees the root's final
  // steering-only turn. When it does not, awaiting it is a wait on a bare
  // promise with no timer or socket behind it: the event loop drains, node's
  // runner reports "Promise resolution is still pending" and CANCELS every
  // remaining test in the file. Eighteen of this file's twenty-three tests were
  // being voided that way and still reported `fail 0`. A deadline turns that
  // silent void into one legible failure.
  const startedOrTimeout = withDeadline(
    completionStarted,
    20_000,
    'the reviewed root never reached a steering-only turn, so the completion gate never opened',
  );

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      tools?: Array<{ function?: { name?: string }; name?: string }>;
    };
    const toolNames = (body.tools ?? []).map((tool) => (
      tool.function?.name ?? tool.name ?? ''
    ));
    if (!launchSent && toolNames.includes('run_workflow')) {
      launchSent = true;
      return new Response(JSON.stringify({
        choices: [{ message: {
          content: '',
          tool_calls: [{
            id: 'call_reviewed_launch',
            type: 'function',
            function: { name: 'run_workflow', arguments: JSON.stringify(args) },
          }],
        } }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Reviewed descendants retain a normal bounded tool surface. Once the
    // workflow child is done, the root has only its steering control left.
    if (launchSent && toolNames.length <= 1) {
      markCompletionStarted();
      // Bounded for the same reason the start signal is: if a test never calls
      // releaseCompletion(), this await never settles, the fetch never resolves,
      // the turn never returns, and node's runner drains the event loop and
      // CANCELS every test still queued in this file. Eleven were being
      // discarded that way while the file reported `fail 0`.
      await withDeadline(completionGate, 20_000, 'releaseCompletion() was never called');
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'done' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  return {
    completionStarted: startedOrTimeout,
    releaseCompletion,
    restore() { globalThis.fetch = originalFetch; },
  };
}

const CALLBACKS = {
  onStatusUpdate: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
};

function enableEngineeringWorkspace(workspace: string): void {
  saveWorkspaceManifest(workspace, createWorkspaceManifest({
    name: 'intent-runtime',
    profile: 'engineering',
    by: 'wizard',
  }));
}

function writeWorkspaceRole(
  workspace: string,
  id: string,
  overrides: Partial<AgentDefinition> = {},
): string {
  const filePath = path.join(workspace, '.brainrouter', 'agents', `${id}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const definition: AgentDefinition = {
    schemaVersion: 1,
    kind: 'orchestration-role',
    id,
    displayName: id,
    whenToUse: `Use ${id} for reviewed work.`,
    prompt: `APPROVED_ROLE_PROMPT_${id}`,
    model: null,
    effort: null,
    defaultAccess: 'read',
    toolScope: { local: [], mcp: [] },
    disallowedTools: [],
    maxIterations: 10,
    timeoutMs: 30_000,
    maxResultChars: 2_000,
    subagents: [],
    delegateName: `delegate_${id.replaceAll('-', '_')}`,
    tier: 'worker',
    outputContract: null,
    ...overrides,
  };
  fs.writeFileSync(filePath, JSON.stringify(definition), 'utf8');
  return filePath;
}

function runStoreExists(workspace: string): boolean {
  const root = path.join(workspace, '.brainrouter', 'workflows');
  if (!fs.existsSync(root)) return false;
  return fs.readdirSync(root, { recursive: true }).some((entry) => String(entry).endsWith('run.json'));
}

test('ADR-040 A40-2 model-authored durable launch is hidden and rejected before confirmation or persistence', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const llm = stubToolTurn('run_workflow', {
      template: 'build',
      templateArgs: { task: 'model-authored launch' },
    });
    let confirmations = 0;
    const results: string[] = [];
    try {
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      agent.confirmRunWorkflowLaunch = async () => {
        confirmations += 1;
        return true;
      };
      await agent.runTurn('implement this', {
        ...CALLBACKS,
        onToolEnd: (_name, result) => results.push(result.preview ?? result.summary),
      });
      assert.equal(confirmations, 0);
      assert.equal(runStoreExists(workspace), false);
      assert.ok(llm.advertised.every((names) => !names.includes('run_workflow')));
      assert.match(results.join('\n'), /explicit \/workflow or \/build command|cannot authorize durable execution/i);
    } finally {
      llm.restore();
    }
  });
});

test('ADR-040 A40-2 exact user-command intent exposes only phase launch, reaches cost gate once, and cannot replay', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const args = {
      template: 'build',
      templateArgs: { task: 'authorized launch' },
    };
    const llm = stubToolTurn('run_workflow', args);
    let confirmations = 0;
    try {
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const handle = await agent.issueExecutionIntent({
        source: 'user-command',
        toolName: 'run_workflow',
        args,
      });
      agent.confirmRunWorkflowLaunch = async () => {
        confirmations += 1;
        return false;
      };
      await agent.runTurn('run the reviewed workflow', CALLBACKS, {
        executionIntent: handle,
      });
      assert.equal(confirmations, 1);
      assert.equal(runStoreExists(workspace), false, 'declined cost gate runs before persistence');
      assert.ok(llm.advertised[0]?.includes('run_workflow'));
      assert.equal(llm.advertised[0]?.includes('run_workflow_graph'), false);
      const transcriptCount = agent.chatHistory.length;
      await assert.rejects(
        agent.runTurn('replay', CALLBACKS, { executionIntent: handle }),
        /not-issued|explicit command|reviewed UI/i,
      );
      assert.equal(agent.chatHistory.length, transcriptCount, 'replay is refused before transcript mutation');
    } finally {
      llm.restore();
    }
  });
});

test('ADR-040 A40-2 an approved exact plan executes once and persists content-free launch lineage', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    resetExtensionContributions();
    setCliKnobOverride({ hooks: { enabled: true, enforceWhenSilent: true } });
    let extensionPreTurnCalls = 0;
    let extensionPostToolCalls = 0;
    registerExtensionHook({
      event: 'pre-turn',
      handle: () => { extensionPreTurnCalls += 1; },
    }, 'reviewed-pre-turn');
    registerExtensionHook({
      event: 'post-tool',
      handle: () => { extensionPostToolCalls += 1; },
    }, 'reviewed-post-tool');
    const args = {
      slug: 'approved-exact-plan',
      plan: {
        title: 'Inspect once',
        phases: [{
          id: 'inspect',
          title: 'Inspect',
          agents: [{ role: 'explorer', access: 'read', prompt: 'Inspect the reviewed workspace.' }],
        }],
      },
    };
    const llm = stubToolTurn('run_workflow', args);
    try {
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const handle = await agent.issueExecutionIntent({
        source: 'user-command',
        toolName: 'run_workflow',
        args,
      });
      agent.confirmRunWorkflowLaunch = async () => true;

      await agent.runTurn('run the reviewed workflow', CALLBACKS, {
        executionIntent: handle,
      });

      const run = readRun(workspace, 'approved-exact-plan');
      assert.equal(run?.status, 'completed');
      assert.match(run?.runId ?? '', /^[0-9a-f-]{36}$/);
      assert.equal(run?.parentExecutionId, run?.launch?.turnId);
      assert.equal(run?.launch?.source, 'user-command');
      assert.equal(run?.launch?.target.topology, 'phase-plan');
      assert.equal((run?.launch as unknown as { prompt?: unknown }).prompt, undefined);
      assert.ok(
        llm.advertised.slice(1).every((names) => !names.some((name) => (
          name === 'spawn_agent'
          || name === 'spawn_agents'
          || name === 'task_agent'
          || name === 'close_agent'
        ))),
        'reviewed children do not receive model-driven orchestration controls',
      );
      assert.equal(
        extensionPreTurnCalls,
        0,
        'open-ended extension pre-turn hooks are suppressed for reviewed execution',
      );
      assert.equal(
        extensionPostToolCalls,
        0,
        'open-ended extension post-tool hooks are suppressed for reviewed execution',
      );
    } finally {
      llm.restore();
      resetExtensionContributions();
    }
  });
});

test('ADR-040 A40-2 reviewed legacy role uses captured restrictive prompt and access and suppresses route feedback', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const manifest = createWorkspaceManifest({
      name: 'captured-role',
      profile: 'engineering',
      by: 'wizard',
    });
    if (!manifest.orchestration.availableRoles.includes('worker')) {
      manifest.orchestration.availableRoles.push('worker');
    }
    saveWorkspaceManifest(workspace, manifest);
    const rolePath = writeWorkspaceRole(workspace, 'worker', {
      displayName: 'Approved restrictive worker',
      whenToUse: 'APPROVED_ROLE_DESCRIPTION',
      prompt: 'APPROVED_ROLE_PROMPT',
      defaultAccess: 'read',
      toolScope: { local: ['read_file'], mcp: [] },
    });
    const approvedRole = fs.readFileSync(rolePath, 'utf8');
    const snapshot = captureReviewedExecutionPolicy(workspace, 'reviewed-role-parent');
    writeWorkspaceRole(workspace, 'worker', {
      displayName: 'Transient permissive worker',
      whenToUse: 'TRANSIENT_ROLE_DESCRIPTION',
      prompt: 'TRANSIENT_ROLE_PROMPT',
      defaultAccess: 'shell',
      toolScope: { local: ['*'], mcp: ['*'] },
    });

    const originalFetch = globalThis.fetch;
    const modelRequests: string[] = [];
    const mcpCalls: string[] = [];
    const mcp = {
      listTools: async () => ({ tools: [{ name: 'memory_capture_turn' }] }),
      callTool: async (name: string) => {
        mcpCalls.push(name);
        return { content: [{ text: '{}' }] };
      },
      close: async () => {},
    } as any;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      modelRequests.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'captured role complete' } }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    setCliKnobOverride({ childWorkspaceIsolation: 'off' });
    try {
      const output = await handleSpawn({
        role: 'worker',
        prompt: 'Inspect the reviewed role policy and report back.',
        wait: true,
      }, {
        workspaceRoot: workspace,
        parentSessionKey: 'reviewed-role-parent',
        executionAuthorityGuard: () => {},
        executionPolicyWorkspaceRoot: workspace,
        executionPolicySnapshot: snapshot,
        executionInstructionSummary: snapshot.instructionSummary,
        parentAccessMode: 'shell',
        parentExecutionMode: snapshot.activeMode.executionMode,
        parentReviewPolicy: snapshot.activeMode.reviewPolicy,
        mcpClient: mcp,
        llmConfig: { provider: 'openai', apiKey: 'k', model: 'test-model' },
        launchCwd: workspace,
        depth: 0,
      });

      assert.match(output, /captured role complete/i);
      const sent = modelRequests.join('\n');
      assert.match(sent, /APPROVED_ROLE_PROMPT/);
      assert.doesNotMatch(sent, /TRANSIENT_ROLE_PROMPT/);
      assert.equal(
        mcpCalls.some((name) => /memory_capture_turn$/.test(name)),
        false,
        'reviewed success emits no route-feedback or agent-output memory capture',
      );
      await assert.rejects(
        handleSpawn({
          role: 'worker',
          prompt: 'Attempt to promote captured role.',
          access: 'shell',
        }, {
          workspaceRoot: workspace,
          parentSessionKey: 'reviewed-role-parent',
          executionAuthorityGuard: () => {},
          executionPolicyWorkspaceRoot: workspace,
          executionPolicySnapshot: snapshot,
          parentAccessMode: 'shell',
          mcpClient: mcp,
          llmConfig: { provider: 'openai', apiKey: 'k', model: 'test-model' },
          launchCwd: workspace,
        } as any),
        /cannot raise role "worker" above its read access ceiling/i,
      );
    } finally {
      fs.writeFileSync(rolePath, approvedRole, 'utf8');
      globalThis.fetch = originalFetch;
    }
    assert.equal(fs.readFileSync(rolePath, 'utf8'), approvedRole, 'role file completes the A-to-B-to-A swap');
  });
});

test('ADR-040 A40-2 consumed root lease survives the launch batch and fences final model completion', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const args = {
      slug: 'final-model-fence',
      plan: {
        title: 'Inspect before final response',
        phases: [{
          id: 'inspect',
          title: 'Inspect',
          agents: [{ role: 'explorer', access: 'read', prompt: 'Inspect once.' }],
        }],
      },
    };
    const llm = stubReviewedTurnWithDelayedCompletion(args);
    const mcpCalls: string[] = [];
    const mcp = makeStubMcp();
    mcp.callTool = async (name: string) => {
      mcpCalls.push(name);
      return { content: [{ text: '{}' }] };
    };
    try {
      const agent = new Agent(mcp, {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const handle = await agent.issueExecutionIntent({
        source: 'user-command', toolName: 'run_workflow', args,
      });
      agent.confirmRunWorkflowLaunch = async () => true;

      const run = agent.runTurn('run the reviewed workflow', CALLBACKS, {
        executionIntent: handle,
      });
      await llm.completionStarted;
      agent.requestSteer('cancel the reviewed launch', { source: 'user' });
      llm.releaseCompletion();

      await assert.rejects(
        run,
        /reviewed instruction changed|authority.*revoked|policy changed|canceled/i,
      );
      assert.equal(agent.lastAnswer, '', 'revoked root never enters finalization');
      assert.equal(agent.sessionUsage.turns, 0, 'revoked root never publishes a completed turn');
      assert.equal(
        mcpCalls.some((name) => /memory_capture_turn$/.test(name)),
        false,
        'reviewed finalization does not run memory capture',
      );
    } finally {
      llm.releaseCompletion();
      llm.restore();
    }
  });
});

test('ADR-040 A40-2 reviewed plans cannot promote a role above its access ceiling', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const agent = new Agent(makeStubMcp(), {
      provider: 'openai', apiKey: 'k', model: 'test-model',
    }, { workspaceRoot: workspace, launchCwd: workspace });

    await assert.rejects(
      agent.issueExecutionIntent({
        source: 'user-command',
        toolName: 'run_workflow',
        args: {
          slug: 'promoted-reviewer',
          plan: {
            title: 'Promoted reviewer',
            phases: [{
              id: 'review',
              title: 'Review',
              agents: [{
                role: 'reviewer',
                access: 'shell',
                prompt: 'Review the implementation.',
              }],
            }],
          },
        },
      }),
      /access above its reviewed role ceiling.*reviewer.*shell requested.*read maximum/i,
    );
    assert.equal(runStoreExists(workspace), false);
  });
});

test('ADR-040 A40-2 reviewed launch purpose rejects sibling side effects before either call runs', async () => {
  for (const workflowFirst of [false, true]) {
    await withTempWorkspaceAsync(async (workspace) => {
      enableEngineeringWorkspace(workspace);
      const args = {
        template: 'build',
        templateArgs: { task: `purpose-${workflowFirst ? 'after' : 'before'}` },
      };
      const workflowCall = { name: 'run_workflow', args };
      const writeCall = {
        name: 'write_file',
        args: { path: 'unreviewed.txt', content: 'must not be written' },
      };
      const llm = stubToolBatchTurn(workflowFirst
        ? [workflowCall, writeCall]
        : [writeCall, workflowCall]);
      let confirmations = 0;
      try {
        const agent = new Agent(makeStubMcp(), {
          provider: 'openai', apiKey: 'k', model: 'test-model',
        }, { workspaceRoot: workspace, launchCwd: workspace });
        const handle = await agent.issueExecutionIntent({
          source: 'user-command', toolName: 'run_workflow', args,
        });
        agent.confirmRunWorkflowLaunch = async () => {
          confirmations += 1;
          return true;
        };
        await agent.runTurn('run only the reviewed workflow', CALLBACKS, {
          executionIntent: handle,
        });
        assert.equal(confirmations, 0);
        assert.equal(fs.existsSync(path.join(workspace, 'unreviewed.txt')), false);
        assert.equal(runStoreExists(workspace), false);
      } finally {
        llm.restore();
      }
    });
  }
});

test('ADR-040 A40-2 mismatched first launch attempt burns intent before cost confirmation', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    addHook(workspace, {
      event: 'pre-tool',
      match: 'run_workflow',
      command: 'touch .unauthorized-workflow-hook-ran',
    });
    const authorized = {
      template: 'build',
      templateArgs: { task: 'authorized task' },
    };
    const llm = stubToolTurn('run_workflow', {
      template: 'build',
      templateArgs: { task: 'different task' },
    });
    let confirmations = 0;
    try {
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const handle = await agent.issueExecutionIntent({
        source: 'user-command',
        toolName: 'run_workflow',
        args: authorized,
      });
      agent.confirmRunWorkflowLaunch = async () => {
        confirmations += 1;
        return true;
      };
      await agent.runTurn('run it', CALLBACKS, { executionIntent: handle });
      assert.equal(confirmations, 0);
      assert.equal(runStoreExists(workspace), false);
      assert.equal(
        fs.existsSync(path.join(workspace, '.unauthorized-workflow-hook-ran')),
        false,
        'mismatched durable launch is rejected before workspace hooks run',
      );
      await assert.rejects(
        agent.runTurn('try again', CALLBACKS, { executionIntent: handle }),
        /not-issued|explicit command|reviewed UI/i,
      );
    } finally {
      llm.restore();
    }
  });
});

test('ADR-040 A40-2 normal access policy denies an exact launch before pre-tool hooks', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const args = {
      template: 'build',
      templateArgs: { task: 'read mode must not launch children' },
    };
    addHook(workspace, {
      event: 'pre-tool',
      match: 'run_workflow',
      command: 'touch .read-mode-workflow-hook-ran',
    });
    const llm = stubToolTurn('run_workflow', args);
    let confirmations = 0;
    try {
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace, accessMode: 'read' });
      const handle = await agent.issueExecutionIntent({
        source: 'user-command',
        toolName: 'run_workflow',
        args,
      });
      agent.confirmRunWorkflowLaunch = async () => {
        confirmations += 1;
        return true;
      };
      await agent.runTurn('run the exact reviewed workflow', CALLBACKS, {
        executionIntent: handle,
      });
      assert.equal(confirmations, 0);
      assert.equal(runStoreExists(workspace), false);
      assert.equal(fs.existsSync(path.join(workspace, '.read-mode-workflow-hook-ran')), false);
    } finally {
      llm.restore();
    }
  });
});

test('ADR-040 A40-2 access downgrade during cost approval revokes launch before persistence', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const args = {
      template: 'build',
      templateArgs: { task: 'downgrade while approving' },
    };
    const llm = stubToolTurn('run_workflow', args);
    try {
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const handle = await agent.issueExecutionIntent({
        source: 'user-command', toolName: 'run_workflow', args,
      });
      agent.confirmRunWorkflowLaunch = async () => {
        agent.setAccessMode('read');
        return true;
      };
      await assert.rejects(
        agent.runTurn('run the reviewed workflow', CALLBACKS, {
          executionIntent: handle,
        }),
        /reviewed instruction changed|policy changed|canceled/i,
      );
      assert.equal(runStoreExists(workspace), false);
    } finally {
      llm.restore();
    }
  });
});

test('ADR-040 A40-2 manifest, MCP catalog, and direct extension drift each invalidate issued authority', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const args = { template: 'build', templateArgs: { task: 'manifest drift' } };
    const manifestPath = workspaceManifestPath(workspace);
    const reviewedManifest = fs.readFileSync(manifestPath, 'utf8');
    const agent = new Agent(makeStubMcp(), {
      provider: 'openai', apiKey: 'k', model: 'test-model',
    }, { workspaceRoot: workspace, launchCwd: workspace });
    const handle = await agent.issueExecutionIntent({
      source: 'user-command', toolName: 'run_workflow', args,
    });
    fs.unlinkSync(manifestPath);
    await assert.rejects(
      agent.runTurn('stale manifest launch', CALLBACKS, { executionIntent: handle }),
      /reviewed workspace.*policy changed/i,
    );
    fs.writeFileSync(manifestPath, reviewedManifest, 'utf8');
    await assert.rejects(
      agent.runTurn('restored manifest must not revive launch', CALLBACKS, {
        executionIntent: handle,
      }),
      /handle was not issued by this live Agent/i,
    );
  });

  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const mcp = makeMutableStubMcp();
    const args = { template: 'build', templateArgs: { task: 'MCP drift' } };
    const agent = new Agent(mcp.client, {
      provider: 'openai', apiKey: 'k', model: 'test-model',
    }, { workspaceRoot: workspace, launchCwd: workspace });
    const handle = await agent.issueExecutionIntent({
      source: 'user-command', toolName: 'run_workflow', args,
    });
    mcp.tools.push({
      name: 'mcp_new_write',
      __rawName: 'write',
      __serverId: 'new',
      description: 'new authority',
      inputSchema: { type: 'object' },
    });
    await assert.rejects(
      agent.runTurn('stale MCP launch', CALLBACKS, { executionIntent: handle }),
      /reviewed (?:MCP tool catalog|workspace.*policy) changed/i,
    );
  });

  await withTempWorkspaceAsync(async (workspace) => {
    resetExtensionContributions();
    try {
      enableEngineeringWorkspace(workspace);
      const args = { template: 'build', templateArgs: { task: 'extension drift' } };
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const handle = await agent.issueExecutionIntent({
        source: 'user-command', toolName: 'run_workflow', args,
      });
      registerExtensionHook({ event: 'pre-tool', handle: () => undefined }, 'late-hook');
      await assert.rejects(
        agent.runTurn('stale extension launch', CALLBACKS, { executionIntent: handle }),
        /reviewed workspace.*policy changed/i,
      );
    } finally {
      resetExtensionContributions();
    }
  });
});

test('ADR-040 A40-2 local policy drift while issuance awaits MCP inventory cancels the reviewed click', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    let releaseInventory!: () => void;
    let inventoryRequested!: () => void;
    const inventoryStarted = new Promise<void>((resolve) => { inventoryRequested = resolve; });
    const inventoryGate = new Promise<void>((resolve) => { releaseInventory = resolve; });
    const mcp = makeStubMcp();
    const agent = new Agent(mcp, {
      provider: 'openai', apiKey: 'k', model: 'test-model',
    }, { workspaceRoot: workspace, launchCwd: workspace });
    await agent.ensureInitialized();
    mcp.listTools = async () => {
      inventoryRequested();
      await inventoryGate;
      return { tools: [] };
    };

    const issuance = agent.issueExecutionIntent({
      source: 'user-command',
      toolName: 'run_workflow',
      args: { template: 'build', templateArgs: { task: 'policy race' } },
    });
    await inventoryStarted;
    fs.unlinkSync(workspaceManifestPath(workspace));
    releaseInventory();

    await assert.rejects(
      issuance,
      /local execution policy changed/i,
    );
  });
});

// ADR-041 D4b.2 (review finding TE-1) — a tool-execution phase hook that REFUSES
// a reviewed durable launch must reject the already-consumed lease and terminate
// the reviewed turn, exactly like the throw/adapter denial paths. Before the fix
// the refuse branch only set a tool result, so the reviewed turn kept looping.
test('ADR-041 D4b.2 — a tool-execution phase-hook refusal of a reviewed durable launch terminates the turn, not loops', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const args = { template: 'build', templateArgs: { task: 'hook-refused reviewed launch' } };
    const llm = stubToolTurn('run_workflow', args);
    resetExtensionContributions();
    let hookFired = 0;
    // A refusing hook: its before() returns without ever calling next().
    registerExtensionPhaseHook('tool-execution', {
      before: () => { hookFired += 1; },
    }, 'test-refuse');
    let confirmations = 0;
    try {
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const handle = await agent.issueExecutionIntent({
        source: 'user-command',
        toolName: 'run_workflow',
        args,
      });
      agent.confirmRunWorkflowLaunch = async () => { confirmations += 1; return true; };
      const answer = await withDeadline(
        agent.runTurn('run the reviewed workflow', CALLBACKS, { executionIntent: handle }),
        20_000,
        'reviewed turn did not terminate after a tool-execution hook refusal (regression: kept looping)',
      );
      assert.ok(hookFired >= 1, 'the tool-execution phase hook fired on the launch');
      assert.equal(confirmations, 0, 'refused before dispatch — the cost gate was never reached');
      assert.equal(runStoreExists(workspace), false, 'a refused launch persists no run');
      assert.match(
        answer,
        /did not proceed|blocked by extension/i,
        'the reviewed turn returned a terminal denial rather than looping',
      );
    } finally {
      llm.restore();
      resetExtensionContributions();
    }
  });
});

// ADR-041 D4b.2 — a provider-call phase hook that REFUSES (never calls next())
// rejects the model call outright; the turn closes with zero steps and records
// the attempt, rather than producing a model response.
test('ADR-041 D4b.2 — a provider-call phase-hook refusal closes the turn with zero steps', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const originalFetch = globalThis.fetch;
    // The model WOULD answer — strategy JSON for the classification pass, a plain
    // message otherwise — but the provider-call hook refuses the main call first.
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[] };
      const content = (body.tools ?? []).length === 0
        ? '{"strategy":"answer-direct","reasoning":"direct","subtasks":[]}'
        : 'model answer';
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    resetExtensionContributions();
    let hookFired = 0;
    registerExtensionPhaseHook('provider-call', {
      before: () => { hookFired += 1; /* refuse: never call next() */ },
    }, 'test-refuse');
    try {
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const answer = await withDeadline(
        agent.runTurn('hello', CALLBACKS),
        20_000,
        'a provider-call hook refusal did not terminate the turn',
      );
      assert.ok(hookFired >= 1, 'the provider-call phase hook fired on the model call');
      assert.match(
        answer,
        /blocked by extension.*provider-call/i,
        'the turn returned the provider-refused terminal, not a model response',
      );
    } finally {
      globalThis.fetch = originalFetch;
      resetExtensionContributions();
    }
  });
});
