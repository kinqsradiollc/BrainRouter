/**
 * Approval-inheritance tests for silent child execution and MCP tool calls.
 *
 * Model responses are stubbed and only the cases that execute shell commands
 * opt out of unattended sandbox enforcement immediately before Agent creation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../agent/agent.js';
import { assessMcpToolApproval } from '../agent/guards/mcpApproval.js';
import { withTempWorkspaceAsync } from './_helpers.js';
import { setCliKnobOverride } from '../config/config.js';
import { listBackgroundShells } from '../exec/runtime/backgroundShell.js';
import {
  createWorker,
  listWorkers,
  readWorkerMeta,
  updateWorkerMeta,
  writeWorkerSummary,
} from '../worker/workerStore.js';
import {
  registerExtensionHook,
  resetExtensionContributions,
} from '../extension/registry.js';

// These tests exercise the silent-child EXEC + approval-inheritance semantics,
// not the sandbox. Under the 0.4.15 unattended default (sandboxEnforceWhenSilent)
// a silent child force-sandboxes run_command and fails closed where no sandboxer
// exists (e.g. Linux CI without bwrap/firejail) — which would refuse the shell
// commands these tests rely on. The two tests that actually execute a shell
// command opt out RIGHT BEFORE constructing the agent (synchronously, so no
// concurrent test can interleave between the override and the constructor that
// captures it). Setting it at module scope is not enough: a sibling file's
// _resetCliKnobsCache() wipes the override before these tests run, since the
// runner shares one process. See sandbox-enforce.test.ts for enforcement itself.

function stubLlmTool(toolName: string, args: Record<string, unknown>): () => void {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    const message = call === 0
      ? {
          content: '',
          tool_calls: [{
            id: 'call_approval',
            type: 'function',
            function: { name: toolName, arguments: JSON.stringify(args) },
          }],
        }
      : { content: 'done.' };
    call++;
    return new Response(JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return () => { globalThis.fetch = originalFetch; };
}

function stubLlmToolBatch(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): () => void {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    const message = call === 0
      ? {
          content: '',
          tool_calls: calls.map((tool, index) => ({
            id: `call_worker_${index}`,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          })),
        }
      : { content: 'done.' };
    call++;
    return new Response(JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return () => { globalThis.fetch = originalFetch; };
}

function makeStubMcp(): any {
  return {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [{ text: '{}' }] }),
    close: async () => {},
  };
}

test('MCP approval classifier honors explicit safety annotations', () => {
  assert.deepEqual(
    assessMcpToolApproval('mcp_github_create_issue', {
      annotations: { destructiveHint: true },
    }),
    {
      requiresApproval: true,
      dangerous: true,
      reason: 'MCP tool is marked destructive by its annotations',
    },
  );
  assert.equal(
    assessMcpToolApproval('mcp_docs_search', {
      annotations: { readOnlyHint: true },
    }).requiresApproval,
    false,
  );
  assert.equal(
    assessMcpToolApproval('mcp_slack_send_message').requiresApproval,
    true,
  );
  assert.deepEqual(
    assessMcpToolApproval('mcp_inventory_lookup_without_annotations'),
    {
      requiresApproval: true,
      dangerous: false,
      reason: 'MCP tool did not provide an explicit trusted read-only annotation',
    },
    'an unannotated remote tool must fail closed even when its name sounds harmless',
  );
});

test('MCP approval network/egress + open-world tools require approval', () => {
  // Open-world annotation, not read-only → gated (the openWorldHint path).
  assert.equal(
    assessMcpToolApproval('mcp_web_search', { annotations: { openWorldHint: true } }).requiresApproval,
    true,
  );
  // Egress-by-name tools a silent child could exfiltrate/side-effect through.
  for (const name of ['mcp_x_broadcast_message', 'mcp_db_replicate_data', 'mcp_bank_transfer_funds', 'mcp_hooks_webhook_post', 'mcp_files_upload', 'mcp_mail_send_email']) {
    assert.equal(assessMcpToolApproval(name).requiresApproval, true, `${name} must require approval`);
  }
});

test('MCP approval readOnly hint cannot whitelist a destructive/egress name', () => {
  // The exact rogue/mis-marked case: tool claims read-only but is named to
  // delete or to exfiltrate. The name wins — approval is still required.
  const del = assessMcpToolApproval('mcp_repo_delete_branch', { annotations: { readOnlyHint: true } });
  assert.equal(del.requiresApproval, true);
  assert.equal(del.dangerous, true);
  assert.equal(
    assessMcpToolApproval('mcp_data_transfer_records', { annotations: { readOnlyHint: true } }).requiresApproval,
    true,
  );
  // A genuinely read-only, non-destructive, non-egress tool is still trusted.
  assert.equal(
    assessMcpToolApproval('mcp_docs_get_page', { annotations: { readOnlyHint: true } }).requiresApproval,
    false,
  );
});

test('parent approval forwards shell approval and runs when parent approves', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const marker = path.join(workspace, 'approved.txt');
    const restore = stubLlmTool('run_command', { command: 'printf approved > approved.txt' });
    const approvals: Array<{ command?: string; reason: string; dangerous?: boolean }> = [];
    try {
      // Opt out of unattended sandbox enforcement synchronously, immediately
      // before construction — the Agent captures the knob in its constructor,
      // so no concurrent test can race the override away mid-turn.
      setCliKnobOverride({ sandboxEnforceWhenSilent: false });
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'shell',
        silent: true,
        confirmToolApproval: async (info) => {
          approvals.push(info);
          return true;
        },
      });
      await agent.runTurn('run child command', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].command, 'printf approved > approved.txt');
      assert.equal(approvals[0].dangerous, false);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'approved');
    } finally {
      restore();
    }
  });
});

test('ADR-040 reviewed children cannot detach or control process-global background shells', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    setCliKnobOverride({ sandboxEnforceWhenSilent: false, sandbox: 'off' });
    const command = 'printf forbidden > reviewed-background.txt';
    const agent = new Agent(makeStubMcp(), {
      provider: 'openai', apiKey: 'k', model: 'test-model',
    }, {
      workspaceRoot: workspace,
      launchCwd: workspace,
      accessMode: 'shell',
      silent: true,
      executionAuthorityGuard: () => {},
      parentExecutionMode: 'planning',
      parentReviewPolicy: 'request',
      confirmToolApproval: async () => true,
    });

    const denied = await agent.executeLocalTool('run_command', {
      command,
      background: true,
    });
    assert.match(denied, /background run_command is unavailable inside reviewed execution/i);
    assert.equal(listBackgroundShells().some((run) => run.command === command), false);
    assert.equal(fs.existsSync(path.join(workspace, 'reviewed-background.txt')), false);
    await assert.rejects(
      agent.executeLocalTool('task_output', { id: 'unrelated' }),
      /background process ids are not execution-owned/i,
    );
    await assert.rejects(
      agent.executeLocalTool('kill_command', { id: 'unrelated' }),
      /background process ids are not execution-owned/i,
    );
  });
});

test('ADR-040 reviewed children cannot guess detached worker lifecycle tools', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const workerId = 'unrelated-worker';
    const secretSummary = 'summary owned by an unrelated root session';
    createWorker(workspace, {
      id: workerId,
      role: 'worker',
      goal: 'unrelated work',
      parentSessionKey: 'session:unrelated',
      pid: null,
    });
    updateWorkerMeta(workspace, workerId, { status: 'completed' });
    writeWorkerSummary(workspace, workerId, secretSummary);

    const workerTools = [
      { name: 'spawn_worker_thread', args: { goal: 'unreviewed detached work' } },
      { name: 'wait_worker', args: { id: workerId, timeoutMs: 0 } },
      { name: 'read_worker_summary', args: { id: workerId } },
      { name: 'close_worker', args: { id: workerId } },
    ];
    const restoreReviewed = stubLlmToolBatch(workerTools);
    const reviewedResults: Array<{ name: string; success: boolean; preview?: string }> = [];
    try {
      const reviewedChild = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        silent: true,
        agentDepth: 1,
        executionAuthorityGuard: () => {},
      });
      await reviewedChild.runTurn('guess hidden worker lifecycle tools', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (name, result) => reviewedResults.push({
          name,
          success: result.success,
          preview: result.preview,
        }),
      });
      assert.deepEqual(reviewedResults.map((result) => result.name), workerTools.map((tool) => tool.name));
      assert.ok(reviewedResults.every((result) => !result.success));
      assert.match(
        reviewedResults.map((result) => result.preview ?? '').join('\n'),
        /detached worker lifecycle tools are unavailable inside inherited reviewed execution|outside the active .*ceiling/i,
      );
      assert.doesNotMatch(JSON.stringify(reviewedChild.chatHistory), new RegExp(secretSummary));
      assert.equal(readWorkerMeta(workspace, workerId)?.status, 'completed');
      assert.equal(listWorkers(workspace).length, 1, 'guessed spawn must not create detached state');
    } finally {
      restoreReviewed();
    }

    const restoreLegacy = stubLlmToolBatch(workerTools.slice(1));
    const legacyResults: Array<{ name: string; success: boolean }> = [];
    try {
      const legacyRoot = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        silent: true,
      });
      await legacyRoot.runTurn('use the existing worker lifecycle tools', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (name, result) => legacyResults.push({ name, success: result.success }),
      });
      assert.deepEqual(legacyResults, workerTools.slice(1).map((tool) => ({
        name: tool.name,
        success: true,
      })));
      assert.match(JSON.stringify(legacyRoot.chatHistory), new RegExp(secretSummary));
      assert.equal(readWorkerMeta(workspace, workerId)?.status, 'closed');
    } finally {
      restoreLegacy();
    }
  });
});

test('ADR-040 delegated hard ceilings deny guessed tools before approval or dispatch', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const marker = path.join(workspace, 'ceiling-escape.txt');
    const restore = stubLlmTool('run_command', {
      command: 'printf escaped > ceiling-escape.txt',
    });
    let approvals = 0;
    const results: Array<{ success: boolean; preview?: string }> = [];
    try {
      setCliKnobOverride({ sandboxEnforceWhenSilent: false, sandbox: 'off' });
      const reviewedChild = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'shell',
        silent: true,
        agentDepth: 1,
        executionAuthorityGuard: () => {},
        authorityToolCeiling: { local: ['read_file'], mcp: [] },
        confirmToolApproval: async () => { approvals += 1; return true; },
      });
      await reviewedChild.runTurn('guess a tool outside the delegated ceiling', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (_name, result) => results.push({
          success: result.success,
          preview: result.preview,
        }),
      });
      assert.equal(approvals, 0, 'a guessed out-of-ceiling tool never reaches approval');
      assert.equal(fs.existsSync(marker), false, 'a guessed out-of-ceiling tool never dispatches');
      assert.equal(results[0]?.success, false);
      assert.match(results[0]?.preview ?? '', /outside the active .*ceiling/i);
    } finally {
      restore();
    }
  });
});

test('ADR-040 a mid-turn skill disallow removes a previously advertised tool before dispatch', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const marker = path.join(workspace, 'dynamic-disallow.txt');
    const restore = stubLlmTool('run_command', {
      command: 'printf escaped > dynamic-disallow.txt',
    });
    let approvals = 0;
    let reviewedChild!: Agent;
    resetExtensionContributions();
    try {
      setCliKnobOverride({
        hooks: { enabled: true, enforceWhenSilent: true },
        sandboxEnforceWhenSilent: false,
        sandbox: 'off',
      });
      registerExtensionHook({
        event: 'pre-tool',
        match: 'run_command',
        handle: () => {
          reviewedChild.activeSkillDisallowedTools = ['run_command'];
        },
      }, 'dynamic-skill-policy');
      reviewedChild = new Agent(makeStubMcp(), {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'shell',
        silent: true,
        agentDepth: 1,
        executionAuthorityGuard: () => {},
        confirmToolApproval: async () => { approvals += 1; return true; },
      });
      const results: Array<{ success: boolean; preview?: string }> = [];
      await reviewedChild.runTurn('attempt a now-disallowed shell tool', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (_name, result) => results.push({
          success: result.success,
          preview: result.preview,
        }),
      });
      assert.equal(approvals, 0);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(results[0]?.success, false);
      assert.match(results[0]?.preview ?? '', /outside the active .*ceiling/i);
    } finally {
      restore();
      resetExtensionContributions();
    }
  });
});

test('ADR-040 model dispatch canonicalizes a unique raw MCP alias before permission checks', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const rawName = 'memory_capture_turn';
    const thirdPartyName = 'mcp_third_memory_capture_turn';
    const mcpTools = [
      {
        name: 'mcp_brain_memory_capture_turn',
        __rawName: rawName,
        __serverId: 'brain',
        inputSchema: { type: 'object' },
      },
      {
        name: thirdPartyName,
        __rawName: rawName,
        __serverId: 'third',
        inputSchema: { type: 'object' },
      },
    ];
    const calls: string[] = [];
    const mcp = {
      listTools: async () => ({ tools: mcpTools }),
      callTool: async (name: string) => {
        calls.push(name);
        return { content: [{ text: '{}' }] };
      },
      getServerIds: () => ['brain', 'third'],
      getStatus: (id: string) => ({
        identity: id === 'brain' ? 'brainrouter' : 'third-party',
      }),
      close: async () => {},
    };
    const restore = stubLlmTool(rawName, {});
    const results: Array<{ success: boolean; preview?: string }> = [];
    try {
      setCliKnobOverride({
        permissions: { allow: [], deny: [thirdPartyName] },
      });
      const agent = new Agent(mcp as any, {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        silent: true,
        confirmToolApproval: async () => true,
      });
      await agent.runTurn('guess the raw MCP alias', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (_name, result) => results.push({
          success: result.success,
          preview: result.preview,
        }),
      });
      assert.deepEqual(calls, []);
      assert.equal(results[0]?.success, false);
      assert.match(
        results[0]?.preview ?? '',
        /mcp_third_memory_capture_turn.*matched a cli\.permissions deny rule/i,
      );
    } finally {
      restore();
    }
  });
});

test('ADR-040 reviewed children cannot switch the reviewed model or provider', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    setCliKnobOverride({
      llmProfiles: {
        current: { model: 'test-model' },
        alternate: { model: 'other-model', endpoint: 'https://other.example/v1' },
      },
    });
    const reviewedChild = new Agent(makeStubMcp(), {
      provider: 'openai', apiKey: 'k', model: 'test-model',
    }, {
      workspaceRoot: workspace,
      launchCwd: workspace,
      silent: true,
      agentDepth: 1,
      executionAuthorityGuard: () => {},
    });
    await assert.rejects(
      reviewedChild.executeLocalTool('switch_model', { profile: 'alternate' }),
      /switch_model is unavailable inside reviewed execution/i,
    );
    assert.equal(reviewedChild.getModel(), 'test-model');
  });
});

test('same-turn result handoff dynamically enables extract_result', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    setCliKnobOverride({ maxToolResultChars: 1_000 });
    const originalFetch = globalThis.fetch;
    const largeOutput = `begin-${'x'.repeat(10_000)}-end`;
    const advertised: string[][] = [];
    let mainCall = 0;
    let remoteCalls = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        tools?: Array<{ function?: { name?: string }; name?: string }>;
        messages?: Array<{ role?: string; content?: string }>;
      };
      const names = (body.tools ?? []).map((tool) => (
        tool.function?.name ?? tool.name ?? ''
      ));
      if (names.length === 0) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: '{"strategy":"answer-direct","reasoning":"direct","subtasks":[]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      advertised.push(names);
      let message: Record<string, unknown>;
      if (mainCall === 0) {
        message = {
          content: '',
          tool_calls: [{
            id: 'call_large',
            type: 'function',
            function: { name: 'large_read', arguments: '{}' },
          }],
        };
      } else if (mainCall === 1) {
        const toolContent = [...(body.messages ?? [])]
          .reverse()
          .find((entry) => entry.role === 'tool')?.content ?? '';
        const resultRef = /resultRef=([^\s\]·]+)/.exec(toolContent)?.[1];
        assert.ok(resultRef, 'the large result advertises a resultRef');
        message = {
          content: '',
          tool_calls: [{
            id: 'call_extract',
            type: 'function',
            function: {
              name: 'extract_result',
              arguments: JSON.stringify({ resultRef }),
            },
          }],
        };
      } else {
        message = { content: 'done.' };
      }
      mainCall += 1;
      return new Response(JSON.stringify({
        choices: [{ message }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const agent = new Agent({
        listTools: async () => ({
          tools: [{
            name: 'large_read',
            annotations: { readOnlyHint: true },
            inputSchema: { type: 'object' },
          }],
        }),
        callTool: async () => {
          remoteCalls += 1;
          return { content: [{ text: largeOutput }] };
        },
        close: async () => {},
      } as any, {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        silent: true,
      });
      const results: Array<{ name: string; success: boolean }> = [];
      await agent.runTurn('read and expand the large result', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (name, result) => results.push({ name, success: result.success }),
      });
      assert.equal(remoteCalls, 1);
      assert.deepEqual(results, [
        { name: 'large_read', success: true },
        { name: 'extract_result', success: true },
      ]);
      assert.equal(advertised[0]?.includes('extract_result'), false);
      assert.equal(advertised[1]?.includes('extract_result'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('ADR-040 nested mcp_call target rechecks reviewed authority after parent approval', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    setCliKnobOverride({ mcpProgressiveDiscovery: true });
    const target = {
      name: 'mcp_remote_delete_record',
      __rawName: 'delete_record',
      __serverId: 'remote',
      annotations: { destructiveHint: true },
      inputSchema: { type: 'object' },
    };
    let remoteCalls = 0;
    let revoked = false;
    const mcp = {
      listTools: async () => ({ tools: [target] }),
      callTool: async () => { remoteCalls += 1; return { content: [{ text: '{}' }] }; },
      getServerIds: () => ['remote'],
      getStatus: () => ({ identity: 'third-party' }),
      close: async () => {},
    };
    const restore = stubLlmTool('mcp_call', {
      name: target.name,
      args: { id: 'record-1' },
    });
    try {
      const reviewedChild = new Agent(mcp as any, {
        provider: 'openai', apiKey: 'k', model: 'test-model',
      }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'shell',
        silent: true,
        agentDepth: 1,
        executionAuthorityGuard: () => {
          if (revoked) throw new Error('reviewed execution authority was revoked');
        },
        authorityToolCeiling: {
          local: ['mcp_call'],
          mcp: [target.name],
        },
        confirmToolApproval: async () => {
          revoked = true;
          return true;
        },
      });
      await assert.rejects(
        reviewedChild.runTurn('call the reviewed MCP target', {
          onStatusUpdate: () => {},
          onToolStart: () => {},
          onToolEnd: () => {},
        }),
        /reviewed execution authority was revoked/i,
      );
      assert.equal(remoteCalls, 0, 'revocation during target approval prevents remote dispatch');
    } finally {
      restore();
      setCliKnobOverride({ mcpProgressiveDiscovery: false });
    }
  });
});

test('CHILD-EXEC-INHERIT silent child auto-runs a SAFE shell command under parent fast (no gate)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const marker = path.join(workspace, 'inherited.txt');
    const restore = stubLlmTool('run_command', { command: 'printf ok > inherited.txt' });
    const approvals: Array<{ command?: string; reason: string }> = [];
    try {
      // See note above: opt out synchronously right before construction.
      setCliKnobOverride({ sandboxEnforceWhenSilent: false });
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'shell',
        silent: true,
        // Parent is in fast/YOLO — a worker's SAFE command must auto-approve
        // (inherit the parent's stance) instead of popping the parent gate.
        parentExecutionMode: 'fast',
        confirmToolApproval: async (info) => { approvals.push(info); return true; },
      });
      await agent.runTurn('run safe child command', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      assert.equal(approvals.length, 0, 'a SAFE command under a fast parent must not forward the gate');
      assert.equal(fs.readFileSync(marker, 'utf8'), 'ok');
    } finally {
      restore();
    }
  });
});

test('CHILD-EXEC-INHERIT silent child STILL gates a DANGEROUS shell command under parent fast (safety floor)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const marker = path.join(workspace, 'should-not-exist.txt');
    const restore = stubLlmTool('run_command', { command: 'rm -rf build-artifacts && printf x > should-not-exist.txt' });
    const approvals: Array<{ command?: string; dangerous?: boolean; reason: string }> = [];
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'shell',
        silent: true,
        // Even a fast/YOLO parent does NOT auto-approve a dangerous child command:
        // the deny-silent floor still forwards the gate. Reject so nothing runs.
        parentExecutionMode: 'fast',
        confirmToolApproval: async (info) => { approvals.push(info); return false; },
      });
      await agent.runTurn('run dangerous child command', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      assert.equal(approvals.length, 1, 'a DANGEROUS command must still forward the gate under fast');
      assert.equal(approvals[0].dangerous, true);
      assert.equal(fs.existsSync(marker), false, 'rejected dangerous command must not run');
    } finally {
      restore();
    }
  });
});

test('WF-NO-NEST a silent child cannot launch run_workflow (blocked outright, not confirmed)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const restore = stubLlmTool('run_workflow', { template: 'build', templateArgs: {} });
    const approvals: Array<{ tool: string; reason: string }> = [];
    const results: Array<{ success: boolean; preview?: string }> = [];
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'shell',
        silent: true,
        // Even full YOLO can't let a spawned/phase child spin up a NESTED
        // workflow — there is no human to confirm to, and that recursion is the
        // "lots of workflows" runaway. It must be refused before any prompt.
        parentExecutionMode: 'fast',
        parentReviewPolicy: 'proceed',
        confirmToolApproval: async (info) => { approvals.push(info as any); return false; },
      });
      await agent.runTurn('launch a workflow', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (_name, result) => results.push({
          success: result.success,
          preview: result.preview,
        }),
      });
      assert.equal(approvals.length, 0, 'run_workflow is blocked for a silent child — never even prompts');
      assert.equal(results[0]?.success, false);
      assert.match(
        results[0]?.preview ?? '',
        /nested workflows are blocked|outside the active .*ceiling|requires an explicit \/workflow or \/build command/i,
      );
    } finally {
      restore();
    }
  });
});

test('parent approval does not run shell when parent rejects', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const marker = path.join(workspace, 'rejected.txt');
    const restore = stubLlmTool('run_command', { command: 'printf rejected > rejected.txt' });
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'shell',
        silent: true,
        confirmToolApproval: async () => false,
      });
      await agent.runTurn('run child command', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      assert.equal(fs.existsSync(marker), false);
    } finally {
      restore();
    }
  });
});

test('parent approval forwards write_file approval before mutating', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const target = path.join(workspace, 'approved-write.txt');
    const restore = stubLlmTool('write_file', { path: 'approved-write.txt', content: 'approved write' });
    const approvals: Array<{ tool: string; path?: string; summary?: string }> = [];
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'write',
        silent: true,
        confirmToolApproval: async (info) => {
          approvals.push(info);
          return true;
        },
      });
      await agent.runTurn('write child file', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].tool, 'write_file');
      assert.equal(approvals[0].path, 'approved-write.txt');
      assert.equal(fs.readFileSync(target, 'utf8'), 'approved write');
    } finally {
      restore();
    }
  });
});

test('DESK-5n Auto mode (parent fast+proceed) auto-allows a silent child write without forwarding approval', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const target = path.join(workspace, 'auto-write.txt');
    const restore = stubLlmTool('write_file', { path: 'auto-write.txt', content: 'auto write' });
    const approvals: Array<{ tool: string }> = [];
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'write',
        silent: true,
        // Parent is in Auto mode — the child write must NOT pop the gate.
        parentExecutionMode: 'fast',
        parentReviewPolicy: 'proceed',
        confirmToolApproval: async (info) => { approvals.push(info); return true; },
      });
      await agent.runTurn('write child file', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      assert.equal(approvals.length, 0, 'Auto mode should not forward child write approval');
      assert.equal(fs.readFileSync(target, 'utf8'), 'auto write');
    } finally {
      restore();
    }
  });
});

test('DESK-5n non-Auto parent (fast + request) STILL forwards the silent child write gate', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const target = path.join(workspace, 'gated-write.txt');
    const restore = stubLlmTool('write_file', { path: 'gated-write.txt', content: 'gated write' });
    const approvals: Array<{ tool: string }> = [];
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'write',
        silent: true,
        parentExecutionMode: 'fast',
        parentReviewPolicy: 'request', // Accept-edits-style: proceed NOT set → gate still asks
        confirmToolApproval: async (info) => { approvals.push(info); return true; },
      });
      await agent.runTurn('write child file', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      assert.equal(approvals.length, 1, 'without proceed the gate must still ask');
      assert.equal(fs.readFileSync(target, 'utf8'), 'gated write');
    } finally {
      restore();
    }
  });
});

test('parent approval does not write_file when parent rejects', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const target = path.join(workspace, 'rejected-write.txt');
    const restore = stubLlmTool('write_file', { path: 'rejected-write.txt', content: 'rejected write' });
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'write',
        silent: true,
        confirmToolApproval: async () => false,
      });
      await agent.runTurn('write child file', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      assert.equal(fs.existsSync(target), false);
    } finally {
      restore();
    }
  });
});

test('parent approval forwards apply_patch approval before mutating', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    fs.writeFileSync(path.join(workspace, 'patch.txt'), 'before\n', 'utf8');
    const patch = [
      '*** Begin Patch',
      '*** Update File: patch.txt',
      '@@',
      '-before',
      '+after',
      '*** End Patch',
    ].join('\n');
    const restore = stubLlmTool('apply_patch', { patch });
    const approvals: Array<{ tool: string; summary?: string }> = [];
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'write',
        silent: true,
        confirmToolApproval: async (info) => {
          approvals.push(info);
          return true;
        },
      });
      await agent.runTurn('patch child file', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].tool, 'apply_patch');
      assert.match(approvals[0].summary ?? '', /1 update/);
      assert.equal(fs.readFileSync(path.join(workspace, 'patch.txt'), 'utf8'), 'after\n');
    } finally {
      restore();
    }
  });
});

test('MCP approval forwards a mutating silent-child call before dispatch', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const restore = stubLlmTool('mcp_github_create_issue', { title: 'Bug', body: 'Details' });
    const approvals: Array<{ tool: string; arguments?: Record<string, unknown>; dangerous?: boolean }> = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    try {
      const agent = new Agent({
        listTools: async () => ({
          tools: [{
            name: 'mcp_github_create_issue',
            __rawName: 'create_issue',
            annotations: { destructiveHint: true },
          }],
        }),
        callTool: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          return { content: [{ text: '{"ok":true}' }] };
        },
        close: async () => {},
      } as any, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'read',
        silent: true,
        confirmToolApproval: async (info) => {
          approvals.push(info);
          return true;
        },
      });
      await agent.runTurn('create issue', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].tool, 'mcp_github_create_issue');
      assert.equal(approvals[0].dangerous, true);
      assert.deepEqual(approvals[0].arguments, { title: 'Bug', body: 'Details' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, 'mcp_github_create_issue');
    } finally {
      restore();
    }
  });
});

test('MCP approval does not dispatch a mutating silent-child call when parent rejects', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const restore = stubLlmTool('mcp_slack_send_message', { channel: 'alerts', text: 'hi' });
    let calls = 0;
    try {
      const agent = new Agent({
        listTools: async () => ({
          tools: [{
            name: 'mcp_slack_send_message',
            __rawName: 'send_message',
          }],
        }),
        callTool: async () => {
          calls++;
          return { content: [{ text: '{"ok":true}' }] };
        },
        close: async () => {},
      } as any, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'read',
        silent: true,
        confirmToolApproval: async () => false,
      });
      await agent.runTurn('send message', {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });
      assert.equal(calls, 0);
    } finally {
      restore();
    }
  });
});
