import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../agent/agent.js';
import { assessMcpToolApproval } from '../agent/mcpApproval.js';
import { withTempWorkspaceAsync } from './_helpers.js';

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

function makeStubMcp(): any {
  return {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [{ text: '{}' }] }),
    close: async () => {},
  };
}

test('CODEX-MCP-APPROVAL classifier honors MCP safety annotations', () => {
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
});

test('CODEX-MCP-APPROVAL network/egress + open-world tools require approval', () => {
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

test('CODEX-MCP-APPROVAL a readOnly hint cannot whitelist a destructive/egress NAME (bypass closed)', () => {
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

test('CODEX-PARENT-APPROVAL silent child forwards shell approval and runs when parent approves', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const marker = path.join(workspace, 'approved.txt');
    const restore = stubLlmTool('run_command', { command: 'printf approved > approved.txt' });
    const approvals: Array<{ command?: string; reason: string; dangerous?: boolean }> = [];
    try {
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

test('CHILD-EXEC-INHERIT silent child auto-runs a SAFE shell command under parent fast (no gate)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const marker = path.join(workspace, 'inherited.txt');
    const restore = stubLlmTool('run_command', { command: 'printf ok > inherited.txt' });
    const approvals: Array<{ command?: string; reason: string }> = [];
    try {
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

test('WF-COST-GATE run_workflow ALWAYS confirms for a silent child even under parent YOLO', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const restore = stubLlmTool('run_workflow', { template: 'build', templateArgs: {} });
    const approvals: Array<{ tool: string; reason: string }> = [];
    try {
      const agent = new Agent(makeStubMcp(), { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
        workspaceRoot: workspace,
        launchCwd: workspace,
        accessMode: 'shell',
        silent: true,
        // Full YOLO — yet a WORKFLOW launch must still warn (token cost).
        parentExecutionMode: 'fast',
        parentReviewPolicy: 'proceed',
        confirmToolApproval: async (info) => { approvals.push(info as any); return false; },
      });
      await agent.runTurn('launch a workflow', { onStatusUpdate: () => {}, onToolStart: () => {}, onToolEnd: () => {} });
      assert.equal(approvals.length, 1, 'run_workflow must confirm even under YOLO');
      assert.equal(approvals[0].tool, 'run_workflow');
    } finally {
      restore();
    }
  });
});

test('CODEX-PARENT-APPROVAL silent child does not run shell when parent rejects', async () => {
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

test('CODEX-PARENT-APPROVAL silent child forwards write_file approval before mutating', async () => {
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

test('CODEX-PARENT-APPROVAL silent child does not write_file when parent rejects', async () => {
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

test('CODEX-PARENT-APPROVAL silent child forwards apply_patch approval before mutating', async () => {
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

test('CODEX-MCP-APPROVAL silent child forwards mutating MCP approval before dispatch', async () => {
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

test('CODEX-MCP-APPROVAL silent child does not dispatch mutating MCP when parent rejects', async () => {
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
