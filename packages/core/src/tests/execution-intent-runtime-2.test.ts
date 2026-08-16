/**
 * ADR-040 A40-2 — second half of the reviewed-intent suite.
 *
 * Split from `execution-intent-runtime.test.ts` because these tests had NEVER
 * RUN. node:test cancels a file's remaining tests when the event loop drains,
 * and something earlier in that file drains it — eighteen tests were being
 * discarded while the file still reported `fail 0`. Bounding two stub gates
 * recovered seven of them; the rest stayed cancelled.
 *
 * A file gets its own process, so moving them here is what makes them execute
 * and become evidence for the first time. It is containment, not a diagnosis:
 * the drain in the sibling file is real and is recorded as open in ADR-040's
 * A40-2 row.
 */
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


/*
 * DECLARED NOT RUNNING, with the reason, rather than silently not running.
 *
 * This test waits for the turn to reach an inventory read that it never reaches
 * — proven by the deadline that replaced its unbounded await, which now fails in
 * 20s instead of draining the event loop and cancelling the rest of the file.
 * Its premise does not hold as written.
 *
 * It has never passed: before the deadline it was cancelled along with ten
 * others while the file reported `fail 0`. Skipping is therefore not a
 * regression — it converts a silent non-run into a declared one, which is the
 * difference between a suite that lies and a suite that is honest about a gap.
 * Recorded as open in ADR-040's A40-2 row.
 */
test('ADR-040 A40-2 a reviewed root turn runs on the approved policy and CANCELS on a mid-flight swap, never runs on the changed one', async () => {
  // The root reviewed turn's protection against an A→B policy swap is TWO
  // reachable guarantees, not a silent rebuild from B (which cannot happen):
  //   1. its system prompt is built from the APPROVED A (instruction, personality,
  //      review policy), captured before anything changes;
  //   2. a swap to B DURING the reviewed launch is caught by the fingerprint
  //      drift check and CANCELS the launch — the turn never proceeds on B.
  // (The descendant-inherits-the-snapshot-across-a-swap case is A40-2's
  // "reviewed legacy role uses captured restrictive prompt and access".)
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const instructionPath = path.join(workspace, 'AGENT.md');
    fs.writeFileSync(instructionPath, 'APPROVED_ROOT_INSTRUCTION_A', 'utf8');
    writePreferences(workspace, { executionMode: 'planning', reviewPolicy: 'request', personality: 'concise' });
    const args = { template: 'build', templateArgs: { task: 'captured root prompt' } };

    const systemPrompts: string[] = [];
    const originalFetch = globalThis.fetch;
    let mainCall = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role?: string; content?: string }>;
      };
      const toolNames = (body.tools ?? []).map((t) => t.function?.name ?? '');
      if (toolNames.length === 0) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: '{"strategy":"answer-direct","reasoning":"d","subtasks":[]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      systemPrompts.push(String(body.messages?.find((mm) => mm.role === 'system')?.content ?? ''));
      const message = mainCall === 0
        ? { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_workflow', arguments: JSON.stringify(args) } }] }
        : { content: 'done' };
      mainCall += 1;
      return new Response(JSON.stringify({
        choices: [{ message }], usage: { prompt_tokens: 20, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const mcp = makeStubMcp();
    mcp.listTools = async () => ({ tools: [] });
    try {
      const agent = new Agent(mcp, { provider: 'openai', apiKey: 'k', model: 'test-model' },
        { workspaceRoot: workspace, launchCwd: workspace });
      const handle = await agent.issueExecutionIntent({ source: 'user-command', toolName: 'run_workflow', args });
      agent.confirmRunWorkflowLaunch = async () => {
        // The A→B swap lands DURING the reviewed launch, past turn start. It must
        // be caught as drift and cancel the launch — not silently proceed on B.
        fs.writeFileSync(instructionPath, 'TRANSIENT_ROOT_INSTRUCTION_B', 'utf8');
        writePreferences(workspace, { executionMode: 'fast', reviewPolicy: 'proceed', personality: 'detailed' });
        setSessionMode(workspace, agent.sessionKey, { executionMode: 'fast', reviewPolicy: 'proceed', personality: 'detailed' });
        return false;
      };

      // Guarantee 2: the mid-flight swap cancels the reviewed launch.
      await assert.rejects(
        agent.runTurn('render only the reviewed root prompt', CALLBACKS, { executionIntent: handle }),
        /reviewed workspace, profile, role, access, skill, permission, model-routing, or delegation policy changed/,
        'a mid-flight policy swap must CANCEL the reviewed launch, never run it on the changed policy',
      );

      // Guarantee 1: the prompt the reviewed turn was built from is the APPROVED A.
      const reviewedPrompt = systemPrompts[0] ?? '';
      assert.match(reviewedPrompt, /APPROVED_ROOT_INSTRUCTION_A/, 'reviewed root prompt uses the approved instruction');
      assert.doesNotMatch(reviewedPrompt, /TRANSIENT_ROOT_INSTRUCTION_B/);
      assert.match(reviewedPrompt, /Communication style: concise/, 'reviewed root prompt uses the approved personality');
      assert.match(reviewedPrompt, /current review policy is `request`/i, 'reviewed root prompt uses the approved review policy');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('ADR-040 A40-2 reviewed graph intent is exact but production execution stays disabled until graph safety gates', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const manifest = createWorkspaceManifest({
      name: 'intent-runtime-graph',
      profile: 'engineering',
      by: 'wizard',
    });
    manifest.version = 3;
    manifest.tools.mode = 'explicit-catalog';
    manifest.tools.profiles.push('workflow-launch');
    manifest.tools.enabled = [];
    saveWorkspaceManifest(workspace, manifest);
    saveWorkflowGraph(workspace, {
      id: 'review-graph',
      name: 'Review graph',
      nodes: [
        { id: 'start', type: 'trigger' },
        { id: 'result', type: 'output', data: { template: 'done' } },
      ],
      edges: [{ id: 'edge', source: 'start', target: 'result' }],
    });
    const llm = stubToolTurn('run_workflow_graph', { id: 'review-graph' });
    const results: string[] = [];
    let confirmations = 0;
    try {
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const handle = await agent.issueExecutionIntent({
        source: 'reviewed-ui',
        toolName: 'run_workflow_graph',
        args: { id: 'review-graph' },
      });
      agent.confirmRunWorkflowLaunch = async () => {
        confirmations += 1;
        return true;
      };
      await agent.runTurn('run the reviewed graph', {
        ...CALLBACKS,
        onToolEnd: (_name, result) => results.push(result.preview ?? result.summary),
      }, { executionIntent: handle });
      assert.equal(confirmations, 0);
      assert.ok(llm.advertised[0]?.includes('run_workflow_graph'));
      assert.equal(llm.advertised[0]?.includes('run_workflow'), false);
      assert.match(results.join('\n'), /production launch is not enabled yet/i);
    } finally {
      llm.restore();
    }
  });
});

test('ADR-040 A40-2 serialized or cloned intent handle fails before a turn begins', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const agent = new Agent(makeStubMcp(), {
      provider: 'openai', apiKey: 'k', model: 'test-model',
    }, { workspaceRoot: workspace, launchCwd: workspace });
    const handle = await agent.issueExecutionIntent({
      source: 'user-command',
      toolName: 'run_workflow',
      args: { template: 'build', templateArgs: { task: 'bounded task' } },
    });
    const clone = structuredClone(handle);
    await assert.rejects(
      agent.runTurn('forged', CALLBACKS, { executionIntent: clone as typeof handle }),
      /unknown or was serialized/i,
    );
    assert.equal(agent.chatHistory.length, 1, 'bootstrap system message is retained, but no user entry is written');
  });
});

test('ADR-040 A40-2 a session switch permanently invalidates an issued handle', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const agent = new Agent(makeStubMcp(), {
      provider: 'openai', apiKey: 'k', model: 'test-model',
    }, { workspaceRoot: workspace, launchCwd: workspace });
    const handle = await agent.issueExecutionIntent({
      source: 'user-command',
      toolName: 'run_workflow',
      args: { template: 'build', templateArgs: { task: 'bounded task' } },
    });
    const originalSession = agent.sessionKey;
    agent.fork('temporary-session');
    agent.fork(originalSession);

    const transcriptCount = agent.chatHistory.length;
    await assert.rejects(
      agent.runTurn('stale reviewed action', CALLBACKS, { executionIntent: handle }),
      /owner-mismatch|explicit command|reviewed UI/i,
    );
    assert.equal(agent.chatHistory.length, transcriptCount);
  });
});

test('ADR-040 A40-2 a workspace A-to-B-to-A switch permanently invalidates an issued handle before activation', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const alternateWorkspace = path.join(workspace, 'alternate-workspace');
    fs.mkdirSync(alternateWorkspace);
    const agent = new Agent(makeStubMcp(), {
      provider: 'openai', apiKey: 'k', model: 'test-model',
    }, { workspaceRoot: workspace, launchCwd: workspace });
    const handle = await agent.issueExecutionIntent({
      source: 'user-command',
      toolName: 'run_workflow',
      args: { template: 'build', templateArgs: { task: 'bounded task' } },
    });

    agent.workspaceRoot = alternateWorkspace;
    agent.workspaceRoot = workspace;

    const transcriptCount = agent.chatHistory.length;
    await assert.rejects(
      agent.runTurn('stale reviewed action', CALLBACKS, { executionIntent: handle }),
      /owner-mismatch|explicit command|reviewed UI/i,
    );
    assert.equal(agent.chatHistory.length, transcriptCount);
  });
});

test('ADR-040 A40-2 a learned-principal A-to-B-to-A mutation permanently invalidates an issued handle', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const agent = new Agent(makeStubMcp(), {
      provider: 'openai', apiKey: 'k', model: 'test-model',
    }, {
      workspaceRoot: workspace,
      launchCwd: workspace,
      learnedTenant: { orgId: 'org-1', userId: 'user-a' },
    });
    const handle = await agent.issueExecutionIntent({
      source: 'user-command',
      toolName: 'run_workflow',
      args: { template: 'build', templateArgs: { task: 'bounded task' } },
    });

    const original = agent.learnedTenant!;
    assert.equal(Object.isFrozen(original), true);
    assert.throws(() => {
      (original as { userId: string }).userId = 'user-b';
    }, /read only|Cannot assign/i);
    agent.learnedTenant = { orgId: 'org-1', userId: 'user-b' };
    agent.learnedTenant = { orgId: 'org-1', userId: 'user-a' };

    const transcriptCount = agent.chatHistory.length;
    await assert.rejects(
      agent.runTurn('stale reviewed action', CALLBACKS, { executionIntent: handle }),
      /owner-mismatch|explicit command|reviewed UI/i,
    );
    assert.equal(agent.chatHistory.length, transcriptCount);
  });
});

test('ADR-040 A40-2 model and provider A-to-B-to-A changes permanently invalidate an issued handle', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const agent = new Agent(makeStubMcp(), {
      provider: 'provider-a', apiKey: 'k', model: 'model-a', endpoint: 'https://a.invalid/v1',
    }, { workspaceRoot: workspace, launchCwd: workspace });
    const handle = await agent.issueExecutionIntent({
      source: 'user-command',
      toolName: 'run_workflow',
      args: { template: 'build', templateArgs: { task: 'bounded task' } },
    });

    agent.setLLMConfig({
      provider: 'provider-b', model: 'model-b', endpoint: 'https://b.invalid/v1',
    });
    agent.setLLMConfig({
      provider: 'provider-a', model: 'model-a', endpoint: 'https://a.invalid/v1',
    });

    const transcriptCount = agent.chatHistory.length;
    await assert.rejects(
      agent.runTurn('stale reviewed actor', CALLBACKS, { executionIntent: handle }),
      /owner-mismatch|explicit command|reviewed UI/i,
    );
    assert.equal(agent.chatHistory.length, transcriptCount);
  });
});

test('ADR-040 A40-2 provider-role routing A-to-B-to-A edits permanently invalidate an issued handle', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const previousConfigDir = process.env.BRAINROUTER_CONFIG_DIR;
    process.env.BRAINROUTER_CONFIG_DIR = path.join(workspace, 'config');
    _resetCliKnobsCache();
    const configA = {
      activeServer: '',
      servers: {},
      providers: {
        reviewed: {
          provider: 'openai',
          apiKey: 'reviewed-key',
          model: 'reviewed-child',
          endpoint: 'https://reviewed.invalid/v1',
        },
      },
      agentModels: {
        worker: { provider: 'reviewed', model: 'reviewed-child' },
        critic: { provider: 'reviewed', model: 'reviewed-critic' },
      },
    };
    const configB = {
      ...configA,
      providers: {
        alternate: {
          provider: 'openai',
          apiKey: 'alternate-key',
          model: 'alternate-child',
          endpoint: 'https://alternate.invalid/v1',
        },
      },
      agentModels: {
        worker: { provider: 'alternate', model: 'alternate-child' },
        critic: { provider: 'alternate', model: 'alternate-critic' },
      },
    };

    try {
      saveConfig(configA);
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const handle = await agent.issueExecutionIntent({
        source: 'user-command',
        toolName: 'run_workflow',
        args: { template: 'build', templateArgs: { task: 'bounded task' } },
      });

      saveConfig(configB);
      const replacedConfig = path.join(
        process.env.BRAINROUTER_CONFIG_DIR!,
        'config.previous.json',
      );
      fs.renameSync(path.join(process.env.BRAINROUTER_CONFIG_DIR!, 'config.json'), replacedConfig);
      saveConfig(configA);
      fs.rmSync(replacedConfig, { force: true });

      const transcriptCount = agent.chatHistory.length;
      await assert.rejects(
        agent.runTurn('stale reviewed routing', CALLBACKS, { executionIntent: handle }),
        /reviewed.*model-routing.*changed/i,
      );
      assert.equal(agent.chatHistory.length, transcriptCount);
    } finally {
      _resetCliKnobsCache();
      if (previousConfigDir === undefined) delete process.env.BRAINROUTER_CONFIG_DIR;
      else process.env.BRAINROUTER_CONFIG_DIR = previousConfigDir;
    }
  });
});

test('ADR-040 A40-2 using one explicit handle permanently invalidates its pre-issued sibling', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const args = {
      template: 'build',
      templateArgs: { task: 'bounded task' },
    };
    const llm = stubToolTurn('run_workflow', args);
    try {
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const firstHandle = await agent.issueExecutionIntent({
        source: 'user-command',
        toolName: 'run_workflow',
        args,
      });
      const siblingHandle = await agent.issueExecutionIntent({
        source: 'user-command',
        toolName: 'run_workflow',
        args,
      });
      agent.confirmRunWorkflowLaunch = async () => false;

      await agent.runTurn('use the first reviewed action', CALLBACKS, {
        executionIntent: firstHandle,
      });

      const transcriptCount = agent.chatHistory.length;
      await assert.rejects(
        agent.runTurn('use the stale sibling', CALLBACKS, { executionIntent: siblingHandle }),
        /owner-mismatch|explicit command|reviewed UI/i,
      );
      assert.equal(agent.chatHistory.length, transcriptCount);
    } finally {
      llm.restore();
    }
  });
});

test('ADR-040 A40-2 an intervening ordinary turn invalidates a queued intent', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    const args = {
      template: 'build',
      templateArgs: { task: 'bounded task' },
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

      await agent.runTurn('ordinary turn arrived first', CALLBACKS);
      const transcriptCount = agent.chatHistory.length;
      await assert.rejects(
        agent.runTurn('late launch', CALLBACKS, { executionIntent: handle }),
        /owner-mismatch|explicit command|reviewed UI/i,
      );
      assert.equal(agent.chatHistory.length, transcriptCount);
    } finally {
      llm.restore();
    }
  });
});

/*
 * ADR-040 A40-2 — this test runs LAST, deliberately.
 *
 * It mutates process-wide state that its teardown cannot fully undo: it enables
 * hooks through a global knob override, monkey-patches `fs.readFileSync`, and
 * resets the extension-contribution registry. Whatever survives that, two
 * unrelated tests below it began failing ONLY when run after it — both pass
 * alone, and both pass when paired with any other predecessor. Bisection named
 * this test; eliminating the knob override and the extension reset individually
 * did not fix it, so the exact residue is still unidentified.
 *
 * Ordering it last is a containment, not a cure: node:test runs a file's tests
 * in declaration order, so with nothing after it there is nothing to poison. The
 * honest fix is to find what leaks and stop it leaking, and that is recorded as
 * open in ADR-040's A40-2 row rather than papered over by this comment.
 */
test('ADR-040 A40-2 reviewed pre-tool hooks execute the approval-time A snapshot across an A-to-B-to-A swap', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    enableEngineeringWorkspace(workspace);
    resetExtensionContributions();
    setCliKnobOverride({ hooks: { enabled: true, enforceWhenSilent: true } });
    const approvedMarker = path.join(workspace, '.approved-hook-ran');
    const swappedMarker = path.join(workspace, '.swapped-hook-ran');
    const hooksPath = getStateFile(workspace, 'hooks.json');
    const approvedBackup = path.join(workspace, '.approved-hooks.json');
    addHook(workspace, {
      event: 'pre-tool',
      match: 'run_workflow',
      command: `touch ${JSON.stringify(approvedMarker)} && cp ${JSON.stringify(approvedBackup)} ${JSON.stringify(hooksPath)}`,
    });
    const approvedHooks = fs.readFileSync(hooksPath, 'utf8');
    fs.writeFileSync(approvedBackup, approvedHooks, 'utf8');
    const swappedHooks = JSON.parse(approvedHooks) as { hooks: Array<Record<string, unknown>> };
    swappedHooks.hooks = swappedHooks.hooks.map((hook) => ({
      ...hook,
      id: 'transient-swapped-hook',
      command: `touch ${JSON.stringify(swappedMarker)} && cp ${JSON.stringify(approvedBackup)} ${JSON.stringify(hooksPath)}`,
    }));
    const swappedHooksRaw = JSON.stringify(swappedHooks);
    const args = {
      slug: 'captured-hook-plan',
      plan: {
        title: 'Captured hook plan',
        phases: [{
          id: 'inspect',
          title: 'Inspect',
          agents: [{ role: 'explorer', access: 'read', prompt: 'Inspect once.' }],
        }],
      },
    };
    const llm = stubToolTurn('run_workflow', args);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    let armSwap = false;
    let swapCount = 0;
    registerExtensionHook({
      event: 'pre-tool',
      match: 'run_workflow',
      handle: () => { armSwap = true; },
    }, 'arm-reviewed-hook-swap');
    (fs as any).readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const value = originalReadFileSync(file as any, ...(rest as any));
      if (
        armSwap
        && typeof file !== 'number'
        && path.resolve(String(file)) === path.resolve(hooksPath)
      ) {
        armSwap = false;
        fs.writeFileSync(hooksPath, swappedHooksRaw, 'utf8');
        swapCount += 1;
      }
      return value;
    }) as typeof fs.readFileSync;
    try {
      const agent = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, { workspaceRoot: workspace, launchCwd: workspace });
      const handle = await agent.issueExecutionIntent({
        source: 'user-command', toolName: 'run_workflow', args,
      });
      agent.confirmRunWorkflowLaunch = async () => true;

      await agent.runTurn('run the reviewed hook plan', CALLBACKS, {
        executionIntent: handle,
      });

      assert.equal(swapCount, 1, 'test performs one transient A-to-B swap after revalidation read');
      assert.equal(fs.existsSync(approvedMarker), true, 'captured approved hook A executes');
      assert.equal(fs.existsSync(swappedMarker), false, 'transient unreviewed hook B never executes');
      assert.equal(fs.readFileSync(hooksPath, 'utf8'), approvedHooks, 'approved hook A restores live file state');
    } finally {
      (fs as any).readFileSync = originalReadFileSync;
      llm.restore();
      resetExtensionContributions();
      // This test enables hooks globally via setCliKnobOverride. Leaving that
      // set changes how every LATER test in this file resolves policy, which is
      // how two unrelated tests below it started failing only when run after it.
      // A test that mutates global knobs owns putting them back; relying on the
      // temp-workspace helper to sweep up afterwards is why the leak was hard to
      // see.
      _resetCliKnobsCache();
    }
  });
});
