// ADR-041 D8 Phase 1 — the builtin-tool handler registry + dispatch shim, proven
// on the planner family (the first tools migrated out of the 66-case switch).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invokeBuiltinToolRuntime } from '../extension/builtin/runtime.js';
import {
  builtinToolHandler,
  registeredHandlerNames,
} from '../extension/builtin/handlers/index.js';
import { ResultCache } from '../util/result/resultHandoff.js';

const PLANNER = ['planner_today', 'planner_find', 'planner_add', 'planner_schedule', 'planner_complete'];

// The Agent surface the planner tools read: none. A bare object suffices, exactly
// as the other invokeBuiltinToolRuntime tests build their `this`.
const host = () => ({ silent: false, agentDepth: 0, tier: 'chat' });

test('D8 — the planner tools dispatch through the registry, not the switch', () => {
  for (const name of PLANNER) {
    assert.ok(builtinToolHandler(name), `${name} has a registered handler`);
    assert.ok(registeredHandlerNames().has(name), `${name} is in the registered set`);
  }
  // A tool still living in the switch must NOT be in the registry — the registry
  // holds exactly the migrated tools, so the coverage stays partitioned.
  assert.equal(builtinToolHandler('run_command'), undefined, 'run_command is still switch-dispatched');
});

test('D8 — migrated planner tools behave byte-for-byte as before (round-trip + validation)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-planner-'));
  const prev = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const added = JSON.parse(await invokeBuiltinToolRuntime.call(host(), 'planner_add', { title: 'ship D8' }));
    assert.equal(typeof added.id, 'string');
    assert.equal(added.title, 'ship D8');

    const found = JSON.parse(await invokeBuiltinToolRuntime.call(host(), 'planner_find', { query: 'ship' }));
    assert.ok(found.items.some((i: { id: string }) => i.id === added.id), 'planner_find returns the added item');

    const today = JSON.parse(await invokeBuiltinToolRuntime.call(host(), 'planner_today', {}));
    assert.ok(Array.isArray(today.items), 'planner_today returns an items array');
    assert.ok('syncState' in today && 'drift' in today, 'planner_today keeps its summary shape');

    const completed = JSON.parse(await invokeBuiltinToolRuntime.call(host(), 'planner_complete', { itemId: added.id }));
    assert.deepEqual(completed, { id: added.id, completed: true });

    // The exact validation errors the switch case threw are preserved verbatim.
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host(), 'planner_add', {}), /A title is required/);
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(host(), 'planner_schedule', { itemId: 'x', estimateMinutes: 0 }),
      /A positive estimate is required/,
    );
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(host(), 'planner_complete', { itemId: 'nope' }),
      /No planner item/,
    );
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 2 — research_brief, the first tool migrated with a non-empty
// BuiltinToolHost (workspaceRoot + sessionKey read via ctx.host).
test('D8 Phase 2 — research_brief dispatches through a workspaceRoot/sessionKey host', async () => {
  assert.ok(builtinToolHandler('research_brief'), 'research_brief has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-research-'));
  try {
    const withWs = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 'test-session' };
    // With no ledger recorded yet, the handler returns the exact string the case did.
    const brief = await invokeBuiltinToolRuntime.call(withWs, 'research_brief', {});
    assert.match(brief, /No research ledger yet — record evidence with research_note first\./);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 3 — the MCP read tools, migrated with host METHODS.
test('D8 Phase 3 — MCP read tools dispatch through host methods', async () => {
  for (const n of ['mcp_search', 'mcp_describe', 'mcp_refresh_catalog']) {
    assert.ok(builtinToolHandler(n), `${n} has a registered handler`);
  }
  const mcpHost = {
    silent: false, agentDepth: 0, tier: 'chat',
    visibleMcpToolList: async () => [
      { name: 'srv_toolA', description: 'A', __serverId: 'srv' },
      { name: 'srv_toolB', description: 'B', __serverId: 'srv' },
    ],
    findVisibleMcpTool: async (t: string) =>
      t === 'srv_toolA' ? { name: 'srv_toolA', description: 'A', inputSchema: {} } : undefined,
    serverIdFromMcpToolName: () => 'srv',
  };
  const search = JSON.parse(await invokeBuiltinToolRuntime.call(mcpHost, 'mcp_search', { query: 'toolA' }));
  assert.equal(search.query, 'toolA');
  assert.ok(Array.isArray(search.tools));

  const described = JSON.parse(await invokeBuiltinToolRuntime.call(mcpHost, 'mcp_describe', { name: 'srv_toolA' }));
  assert.equal(described[0].name, 'srv_toolA');
  const missing = JSON.parse(await invokeBuiltinToolRuntime.call(mcpHost, 'mcp_describe', { name: 'nope' }));
  assert.match(missing[0].error, /not found/);

  const refreshed = JSON.parse(await invokeBuiltinToolRuntime.call(mcpHost, 'mcp_refresh_catalog', {}));
  assert.equal(refreshed.totalTools, 2);
  assert.equal(refreshed.servers.srv, 2);

  await assert.rejects(() => invokeBuiltinToolRuntime.call(mcpHost, 'mcp_search', {}), /non-empty/);
  await assert.rejects(() => invokeBuiltinToolRuntime.call(mcpHost, 'mcp_describe', {}), /requires `name`/);
});

// ADR-041 D8 Phase 4 — connector_list (read-only, workspaceRoot; no new host field).
test('D8 Phase 4 — connector_list dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('connector_list'), 'connector_list has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-conn-'));
  try {
    const withWs = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 's' };
    const out = JSON.parse(await invokeBuiltinToolRuntime.call(withWs, 'connector_list', {}));
    assert.ok(Array.isArray(out), 'connector_list returns an array (empty when none configured)');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 5 — track_query (read-only, workspaceRoot only).
test('D8 Phase 5 — track_query dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('track_query'), 'track_query has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-track-'));
  try {
    const withWs = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 's' };
    const list = JSON.parse(await invokeBuiltinToolRuntime.call(withWs, 'track_query', {}));
    assert.ok(Array.isArray(list), 'the default list action returns an array');
    const board = JSON.parse(await invokeBuiltinToolRuntime.call(withWs, 'track_query', { action: 'board' }));
    assert.ok(board.project && Array.isArray(board.columns), 'board action returns project + columns');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 6 — read_worker_summary (read-only, workspaceRoot only).
test('D8 Phase 6 — read_worker_summary dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('read_worker_summary'), 'read_worker_summary has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-worker-'));
  try {
    const withWs = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 's' };
    const out = await invokeBuiltinToolRuntime.call(withWs, 'read_worker_summary', { id: 'nope' });
    assert.match(out, /No worker "nope"/, 'returns the exact former no-worker message');
    await assert.rejects(() => invokeBuiltinToolRuntime.call(withWs, 'read_worker_summary', {}), /requires an id/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});


// ADR-041 D8 Phase 7 — extract_result (read-only; grows the host by resultCache).
test('D8 Phase 7 — extract_result dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('extract_result'), 'extract_result has a registered handler');
  const cache = new ResultCache(60_000, 10);
  cache.put('r-1', 'alpha beta gamma\ndelta epsilon zeta');
  const host = { silent: false, agentDepth: 0, tier: 'chat', resultCache: cache };
  const head = await invokeBuiltinToolRuntime.call(host, 'extract_result', { resultRef: 'r-1' });
  assert.match(head, /alpha beta gamma/, 'returns the cached result head');
  const missing = await invokeBuiltinToolRuntime.call(host, 'extract_result', { resultRef: 'nope' });
  assert.match(missing, /not found or expired/, 'unknown ref returns the former not-found message');
  await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'extract_result', {}), /requires a resultRef/);
});

// ADR-041 D8 Phase 8 — research_note (session-state write, zero host growth).
test('D8 Phase 8 — research_note dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('research_note'), 'research_note has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-note-'));
  try {
    const host = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 's8' };
    const out = await invokeBuiltinToolRuntime.call(host, 'research_note', { claim: 'the sky is blue', sources: ['http://a'] });
    assert.match(out, /Recorded\. Ledger: 1 finding/);
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'research_note', {}), /requires a non-empty/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 9 — reconcile_steer + workflow_progress (session/workflow-state
// writers, zero host growth).
test('D8 Phase 9 — reconcile_steer + workflow_progress dispatch through the registry', async () => {
  assert.ok(builtinToolHandler('reconcile_steer'), 'reconcile_steer has a registered handler');
  assert.ok(builtinToolHandler('workflow_progress'), 'workflow_progress has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-sess-'));
  try {
    const host = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 's9' };
    // A fresh workspace has no bound workflow → the deterministic no-workflow message,
    // proving the tool routes through the registry (not the deleted switch case).
    const wf = await invokeBuiltinToolRuntime.call(host, 'workflow_progress', { step: 'x', status: 'done' });
    assert.match(wf, /No active workflow/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 10 — mark_chapter (session-state write; grows host by recordTranscript).
test('D8 Phase 10 — mark_chapter dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('mark_chapter'), 'mark_chapter has a registered handler');
  const captured: any[] = [];
  const host = { silent: false, agentDepth: 0, tier: 'chat', recordTranscript: (m: any) => captured.push(m) };
  const out = await invokeBuiltinToolRuntime.call(host, 'mark_chapter', { title: 'Chapter One', summary: 'did stuff' });
  assert.match(out, /"marked":true/);
  assert.equal(captured.length, 1, 'the marker was persisted via recordTranscript');
  assert.equal(captured[0].role, 'system');
  await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'mark_chapter', {}), /requires a non-empty title/);
  await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'mark_chapter', { title: 'x'.repeat(61) }), /under 60 chars/);
});

// ADR-041 D8 Phase 11 — goal_complete + goal_blocked (session-state writers;
// grow host by the mutable lastGoalTransition field).
test('D8 Phase 11 — goal_complete + goal_blocked dispatch through the registry', async () => {
  assert.ok(builtinToolHandler('goal_complete'), 'goal_complete has a registered handler');
  assert.ok(builtinToolHandler('goal_blocked'), 'goal_blocked has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-goal-'));
  try {
    const host: any = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 'g11', lastGoalTransition: undefined };
    // No active goal (fresh workspace, empty plan) → the deterministic no-goal messages.
    const gc = await invokeBuiltinToolRuntime.call(host, 'goal_complete', { proof: 'all done' });
    assert.match(gc, /No active goal to complete/);
    const gb = await invokeBuiltinToolRuntime.call(host, 'goal_blocked', { reason: 'stuck' });
    assert.match(gb, /No active goal to block/);
    // No goal to transition → the mutable field stays undefined.
    assert.equal(host.lastGoalTransition, undefined);
    // Validation.
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'goal_complete', {}), /requires a non-empty proof/);
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'goal_blocked', {}), /requires a non-empty reason/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 12 — MCP resource reads (grow host by mcpClient + turnAbort).
test('D8 Phase 12 — MCP resource reads dispatch through the registry', async () => {
  for (const n of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
    assert.ok(builtinToolHandler(n), `${n} has a registered handler`);
  }
  const fakeClient = {
    listResources: async (a: any) => ({ resources: ['r1'], echo: a }),
    listResourceTemplates: async () => ({ templates: [] }),
    readResource: async (a: any) => ({ contents: 'hello', uri: a.uri }),
  };
  const host: any = { silent: false, agentDepth: 0, tier: 'chat', mcpClient: fakeClient, turnAbort: null };
  assert.match(await invokeBuiltinToolRuntime.call(host, 'list_mcp_resources', {}), /r1/);
  assert.match(await invokeBuiltinToolRuntime.call(host, 'list_mcp_resource_templates', {}), /templates/);
  assert.match(await invokeBuiltinToolRuntime.call(host, 'read_mcp_resource', { server: 's', uri: 'mcp://x' }), /hello/);
  await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'read_mcp_resource', { server: 's' }), /requires a uri/);
  // A client without resource methods → the exact former unsupported message.
  const bare: any = { silent: false, agentDepth: 0, tier: 'chat', mcpClient: {}, turnAbort: null };
  await assert.rejects(() => invokeBuiltinToolRuntime.call(bare, 'list_mcp_resources', {}), /not supported/);
});

// ADR-041 D8 Phase 13 — pentest/proxy reads (grow host by pentestProxyControl()).
test('D8 Phase 13 — pentest reads dispatch through the registry', async () => {
  for (const n of ['list_requests', 'view_request', 'repeat_request', 'list_sitemap', 'scope_rules']) {
    assert.ok(builtinToolHandler(n), `${n} has a registered handler`);
  }
  const host: any = { silent: false, agentDepth: 0, tier: 'chat', pentestProxyControl: () => undefined };
  // Deterministic validation / scope-guard paths — these reject BEFORE touching the proxy.
  await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'view_request', {}), /requires an id/);
  await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'repeat_request', {}), /requires an id/);
  await assert.rejects(
    () => invokeBuiltinToolRuntime.call(host, 'repeat_request', { id: 'r1', mutation: { host: 'evil.example' } }),
    /must not change the target host/,
  );
});

// ADR-041 D8 Phase 14 — update_plan (session-state write; grows host by maybeAutoApprovePlan).
test('D8 Phase 14 — update_plan dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('update_plan'), 'update_plan has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-plan-'));
  try {
    let approved = 0;
    const host: any = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 'p14', maybeAutoApprovePlan: () => { approved += 1; } };
    const out = await invokeBuiltinToolRuntime.call(host, 'update_plan', {
      plan: [{ step: 'do a thing', status: 'pending' }],
      explanation: 'initial plan',
    });
    assert.ok(typeof out === 'string' && out.length > 0, 'returns a formatted plan');
    assert.equal(approved, 1, 'auto-approval recorded via the host method');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 15 — worktree_list (read-only; grows host by attachedRoots).
test('D8 Phase 15 — worktree_list dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('worktree_list'), 'worktree_list has a registered handler');
  // Runs against the repo the tests live in (a real git worktree).
  const host: any = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: process.cwd(), attachedRoots: [] };
  const out = await invokeBuiltinToolRuntime.call(host, 'worktree_list', {});
  const parsed = JSON.parse(out);
  assert.equal(parsed.primaryRoot, process.cwd());
  assert.ok(Array.isArray(parsed.worktrees), 'returns a structured worktree listing');
});

// ADR-041 D8 Phase 16 — artifact_write (session-scoped write; grows host by captureArtifactToMemory).
test('D8 Phase 16 — artifact_write dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('artifact_write'), 'artifact_write has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-artifact-'));
  try {
    let captured = 0;
    const host: any = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 'a16', captureArtifactToMemory: async () => { captured += 1; } };
    const out = await invokeBuiltinToolRuntime.call(host, 'artifact_write', { title: 'My Report', content: '# Hello' });
    assert.match(out, /Created artifact/);
    assert.equal(captured, 1, 'the created artifact was captured into memory');
    // content present but no title on create → the title-required guard.
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'artifact_write', { content: 'x' }), /is required when creating a new artifact/);
    // updating an unknown id → the not-found guard.
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'artifact_write', { id: 'nope', content: 'x' }), /no artifact "nope"/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 18 — the read-only fs tools (grow host by reviewSourceSafety;
// use resolveHere + fsPort from context).
test('D8 Phase 18 — list_dir / grep_search / glob_files dispatch through the registry', async () => {
  for (const n of ['list_dir', 'grep_search', 'glob_files']) {
    assert.ok(builtinToolHandler(n), `${n} has a registered handler`);
  }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-fsread-'));
  try {
    fs.writeFileSync(path.join(ws, 'a.txt'), 'hello world\nfoo bar');
    fs.mkdirSync(path.join(ws, 'sub'));
    const host: any = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, reviewSourceSafety: false };
    const ld = await invokeBuiltinToolRuntime.call(host, 'list_dir', { path: '.' });
    assert.match(ld, /a\.txt/);
    assert.match(ld, /sub/);
    const gf = await invokeBuiltinToolRuntime.call(host, 'glob_files', { pattern: '**/*.txt' });
    assert.ok(Array.isArray(JSON.parse(gf)), 'glob_files returns a JSON array');
    const gs = await invokeBuiltinToolRuntime.call(host, 'grep_search', { query: 'hello', path: '.' });
    assert.match(gs, /hello/);
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'grep_search', { query: '' }), /Missing parameter "query"/);
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'glob_files', {}), /Missing parameter "pattern"/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 19 — read_file (heaviest read; grows host by filesReadThisSession + maybeReindexSource).
test('D8 Phase 19 — read_file dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('read_file'), 'read_file has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-readfile-'));
  try {
    fs.writeFileSync(path.join(ws, 'f.txt'), 'line1\nline2\nline3');
    const read = new Set<string>();
    let reindexed = 0;
    const host: any = {
      silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, reviewSourceSafety: false,
      filesReadThisSession: read,
      maybeReindexSource: async () => { reindexed += 1; return ''; },
    };
    const full = await invokeBuiltinToolRuntime.call(host, 'read_file', { path: 'f.txt' });
    assert.match(full, /line1/);
    assert.equal(read.size, 1, 'recorded in the read-before-edit ledger');
    assert.equal(reindexed, 1, 'fired the fire-and-forget reindex');
    const slice = await invokeBuiltinToolRuntime.call(host, 'read_file', { path: 'f.txt', startLine: 2, endLine: 2 });
    assert.equal(slice.trim(), 'line2');
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'read_file', { path: 'nope.txt' }), /File not found/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 20 — the last gate-free tools: wait_until + lsp (fsRead) + finish_scan (pentest).
test('D8 Phase 20 — wait_until / lsp / finish_scan dispatch through the registry', async () => {
  for (const n of ['wait_until', 'lsp', 'finish_scan']) {
    assert.ok(builtinToolHandler(n), `${n} has a registered handler`);
  }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-last-'));
  try {
    fs.writeFileSync(path.join(ws, 'ready.txt'), 'ok');
    const host: any = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, reviewSourceSafety: false };
    // wait_until: an already-satisfied file_exists returns immediately.
    const wu = await invokeBuiltinToolRuntime.call(host, 'wait_until', { condition: 'file_exists', path: 'ready.txt', timeoutMs: 1000 });
    assert.match(wu, /"path":"ready.txt"/);
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'wait_until', { condition: 'bogus', path: 'x' }), /condition "file_exists" or "file_contains"/);
    // lsp: validation gates before any language server is started.
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'lsp', { action: 'nope', file: 'x' }), /action must be/);
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'lsp', { action: 'definition' }), /requires a `file`/);
    // finish_scan: no active pentest run in a fresh workspace → the deterministic refusal.
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'finish_scan', {}), /requires an active pentest review run/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 21 — task_output (first DEFER tool; grows host by inheritedExecutionAuthorityGuard).
test('D8 Phase 21 — task_output dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('task_output'), 'task_output has a registered handler');
  const host: any = { silent: false, agentDepth: 0, tier: 'chat', inheritedExecutionAuthorityGuard: () => undefined };
  const out = await invokeBuiltinToolRuntime.call(host, 'task_output', { id: 'nope' });
  assert.match(out, /"found":false/);
  await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'task_output', {}), /requires an id/);
  // Inside reviewed execution the guard returns a cleanup fn (truthy) → refused.
  const reviewed: any = { silent: false, agentDepth: 0, tier: 'chat', inheritedExecutionAuthorityGuard: () => () => {} };
  await assert.rejects(() => invokeBuiltinToolRuntime.call(reviewed, 'task_output', { id: 'x' }), /unavailable inside reviewed execution/);
});

// ADR-041 D8 Phase 22 — switch_model (grows host by llmConfig + setLLMConfig).
test('D8 Phase 22 — switch_model dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('switch_model'), 'switch_model has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-model-'));
  try {
    let applied: any = null;
    const host: any = {
      silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 'm22',
      inheritedExecutionAuthorityGuard: () => undefined,
      llmConfig: { model: 'gpt-x', endpoint: 'https://e/v1', apiKey: '' },
      setLLMConfig: (c: any) => { applied = c; },
    };
    // Unknown profile → a structured failure, not a throw (resolveProfileSwitch).
    const out = await invokeBuiltinToolRuntime.call(host, 'switch_model', { profile: 'does-not-exist-xyz' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.switched, false, 'unknown profile is rejected without switching');
    assert.equal(applied, null, 'no live config overlay on a failed switch');
    // Inside reviewed execution → refused before anything.
    const reviewed: any = { ...host, inheritedExecutionAuthorityGuard: () => () => {} };
    await assert.rejects(() => invokeBuiltinToolRuntime.call(reviewed, 'switch_model', { profile: 'x' }), /unavailable inside reviewed execution/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 23 — wait_worker + close_worker (worker lifecycle, zero host growth).
test('D8 Phase 23 — wait_worker + close_worker dispatch through the registry', async () => {
  assert.ok(builtinToolHandler('wait_worker'), 'wait_worker has a registered handler');
  assert.ok(builtinToolHandler('close_worker'), 'close_worker has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-worker-'));
  try {
    const host: any = { silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 'w23' };
    // Unknown worker id → deterministic not-found / unknown across a fresh workspace.
    const wc = await invokeBuiltinToolRuntime.call(host, 'close_worker', { id: 'nope' });
    assert.match(wc, /"closed":false/);
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'wait_worker', {}), /requires an id/);
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'close_worker', {}), /requires an id/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 24 — kill_command (exec family, zero host growth).
test('D8 Phase 24 — kill_command dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('kill_command'), 'kill_command has a registered handler');
  const host: any = { silent: false, agentDepth: 0, tier: 'chat', inheritedExecutionAuthorityGuard: () => undefined };
  const out = await invokeBuiltinToolRuntime.call(host, 'kill_command', { id: 'nope' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.killed, false);
  await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'kill_command', {}), /requires an id/);
  const reviewed: any = { silent: false, agentDepth: 0, tier: 'chat', inheritedExecutionAuthorityGuard: () => () => {} };
  await assert.rejects(() => invokeBuiltinToolRuntime.call(reviewed, 'kill_command', { id: 'x' }), /unavailable inside reviewed execution/);
});

// ADR-041 D8 Phase 25 — terminal_list + terminal_read (PTY reads; grow host by terminalUsePort + session flags).
test('D8 Phase 25 — terminal reads dispatch through the registry', async () => {
  assert.ok(builtinToolHandler('terminal_list'), 'terminal_list has a registered handler');
  assert.ok(builtinToolHandler('terminal_read'), 'terminal_read has a registered handler');
  // Headless (no terminalUsePort) → the deterministic unavailable message.
  const headless: any = { silent: false, agentDepth: 0, tier: 'chat' };
  assert.match(await invokeBuiltinToolRuntime.call(headless, 'terminal_list', {}), /unavailable outside the active top-level/);
  // Top-level Desktop session with a port → works.
  const port = {
    list: () => [{ id: 't1', shell: 'bash', pid: 1, start: 0, next: 5, alive: true }],
    read: (_id: string, _off: number) => ({ chunk: 'hello', next: 5, alive: true, dropped: 0 }),
    write: () => true,
  };
  const host: any = { silent: false, agentDepth: 0, tier: 'chat', terminalUsePort: port };
  assert.match(await invokeBuiltinToolRuntime.call(host, 'terminal_list', {}), /t1/);
  assert.match(await invokeBuiltinToolRuntime.call(host, 'terminal_read', { id: 't1' }), /hello/);
  assert.match(await invokeBuiltinToolRuntime.call(host, 'terminal_read', { id: 'unknown' }), /"found":false/);
  await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'terminal_read', {}), /Missing parameter "id"/);
});

// ADR-041 D8 Phase 26 — terminal_write (first approval-prompt tool; grows host by interactionPort + prompter).
test('D8 Phase 26 — terminal_write dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('terminal_write'), 'terminal_write has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-tw-'));
  try {
    const written: Array<[string, string]> = [];
    const port = {
      list: () => [],
      read: () => ({ chunk: '', next: 0, alive: false, dropped: 0 }),
      write: (id: string, data: string) => { written.push([id, data]); return true; },
    };
    const host: any = {
      silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 't26',
      terminalUsePort: port,
      interactionPort: { confirm: async () => true, choice: async () => [] },
      prompter: {},
    };
    const out = await invokeBuiltinToolRuntime.call(host, 'terminal_write', { id: 't1', data: 'ls\n' });
    assert.match(out, /"written":true/);
    assert.equal(written.length, 1, 'wrote to the port after approval');
    // Decline path.
    const declineHost: any = { ...host, interactionPort: { confirm: async () => false, choice: async () => [] } };
    assert.match(await invokeBuiltinToolRuntime.call(declineHost, 'terminal_write', { id: 't1', data: 'x' }), /rejected by user/);
    // Headless (no terminal port) gate.
    const headless: any = { silent: false, agentDepth: 0, tier: 'chat' };
    assert.match(await invokeBuiltinToolRuntime.call(headless, 'terminal_write', { id: 't1', data: 'x' }), /unavailable outside/);
    // Validation.
    await assert.rejects(() => invokeBuiltinToolRuntime.call(host, 'terminal_write', { id: 't1' }), /Missing parameter "data"/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 27 — ask_user_choice (grows host by hookNotifyActive; reuses interactionPort/prompter).
test('D8 Phase 27 — ask_user_choice dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('ask_user_choice'), 'ask_user_choice has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-ask-'));
  const opts = [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }];
  try {
    // Silent child agents are refused up front (NoTTYError contract).
    const silent: any = { silent: true, agentDepth: 1, tier: 'worker', workspaceRoot: ws, sessionKey: 'a27' };
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(silent, 'ask_user_choice', { question: 'Q', header: 'H', options: opts }),
      /not available to silent child agents/,
    );
    // Interactive top-level session with a UI port → returns the chosen label.
    const host: any = {
      silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 'a27',
      hookNotifyActive: () => false,
      interactionPort: { confirm: async () => true, choice: async () => ['A'] },
      prompter: {},
    };
    assert.match(await invokeBuiltinToolRuntime.call(host, 'ask_user_choice', { question: 'Q', header: 'H', options: opts }), /"answer":"A"/);
    // Validation: 2–4 options required.
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(host, 'ask_user_choice', { question: 'Q', header: 'H', options: [{ label: 'A', description: 'a' }] }),
      /2.4 options/,
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 28 — write_file (write-family foundation; grows host by ownership + 3 write-guard methods).
test('D8 Phase 28 — write_file dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('write_file'), 'write_file has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-write-'));
  try {
    const read = new Set<string>();
    let snapshotted = 0;
    const host: any = {
      silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 'w28', ownership: null,
      filesReadThisSession: read,
      assertInheritedExecutionAuthorityCurrent: () => {},
      captureFileSnapshot: () => { snapshotted += 1; },
      confirmSilentChildToolApproval: async () => null,
      maybeReindexSource: async () => '',
    };
    // Creating a NEW file is allowed.
    const out = await invokeBuiltinToolRuntime.call(host, 'write_file', { path: 'new.txt', content: 'hello' });
    assert.match(out, /Successfully wrote file: new\.txt/);
    assert.equal(fs.readFileSync(path.join(ws, 'new.txt'), 'utf8'), 'hello');
    assert.equal(snapshotted, 1, 'captured an undo snapshot');
    assert.equal(read.size, 1, 'kept the read ledger accurate after write');
    // Overwriting an EXISTING unread file is refused (read-before-overwrite).
    fs.writeFileSync(path.join(ws, 'exists.txt'), 'old');
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(host, 'write_file', { path: 'exists.txt', content: 'new' }),
      /Read-before-overwrite/,
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 29 — edit_file (reuses Phase 28's write-guard host members; targeted in-place replace).
test('D8 Phase 29 — edit_file dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('edit_file'), 'edit_file has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-edit-'));
  try {
    const read = new Set<string>();
    let snapshotted = 0;
    const host: any = {
      silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 'w29', ownership: null,
      filesReadThisSession: read,
      assertInheritedExecutionAuthorityCurrent: () => {},
      captureFileSnapshot: () => { snapshotted += 1; },
      confirmSilentChildToolApproval: async () => null,
      maybeReindexSource: async () => '',
    };
    fs.writeFileSync(path.join(ws, 'edit.txt'), 'alpha BETA gamma');
    const resolved = fs.realpathSync(path.join(ws, 'edit.txt'));
    // Read-before-edit: editing a file not read this session is refused.
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(host, 'edit_file', { path: 'edit.txt', targetContent: 'BETA', replacementContent: 'delta' }),
      /Read-before-edit/,
    );
    // After a read, a unique targeted replace succeeds with the replacement inserted VERBATIM ($ not special).
    read.add(resolved);
    const out = await invokeBuiltinToolRuntime.call(host, 'edit_file', { path: 'edit.txt', targetContent: 'BETA', replacementContent: '$dollar$' });
    assert.match(out, /Successfully edited edit\.txt/);
    assert.equal(fs.readFileSync(path.join(ws, 'edit.txt'), 'utf8'), 'alpha $dollar$ gamma');
    assert.equal(snapshotted, 1, 'captured an undo snapshot before the edit');
    // A target that does not occur is rejected.
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(host, 'edit_file', { path: 'edit.txt', targetContent: 'NOPE', replacementContent: 'x' }),
      /Target content not found/,
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 30 — notebook_edit (write-family; same guard members, .ipynb cell edit).
test('D8 Phase 30 — notebook_edit dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('notebook_edit'), 'notebook_edit has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-nb-'));
  try {
    let snapshotted = 0;
    const host: any = {
      silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 'w30', ownership: null,
      filesReadThisSession: new Set<string>(),
      assertInheritedExecutionAuthorityCurrent: () => {},
      captureFileSnapshot: () => { snapshotted += 1; },
      confirmSilentChildToolApproval: async () => null,
    };
    const nb = { cells: [{ cell_type: 'code', source: ['print(1)'], metadata: {}, execution_count: null, outputs: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
    fs.writeFileSync(path.join(ws, 'nb.ipynb'), JSON.stringify(nb));
    // A non-.ipynb path is refused.
    fs.writeFileSync(path.join(ws, 'notanb.txt'), 'x');
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(host, 'notebook_edit', { path: 'notanb.txt', edit_mode: 'replace', cell_index: 0, source: 'y' }),
      /\.ipynb/,
    );
    // Replacing cell 0 succeeds, snapshots for undo, and rewrites the source.
    const out = await invokeBuiltinToolRuntime.call(host, 'notebook_edit', { path: 'nb.ipynb', edit_mode: 'replace', cell_index: 0, source: 'print(2)' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.edit_mode, 'replace');
    assert.equal(parsed.path, 'nb.ipynb');
    assert.equal(snapshotted, 1, 'captured an undo snapshot before the notebook edit');
    assert.match(fs.readFileSync(path.join(ws, 'nb.ipynb'), 'utf8'), /print\(2\)/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ADR-041 D8 Phase 31 — apply_patch (write-family; V4A envelope apply, completes the write tier).
test('D8 Phase 31 — apply_patch dispatches through the registry', async () => {
  assert.ok(builtinToolHandler('apply_patch'), 'apply_patch has a registered handler');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'd8-patch-'));
  try {
    let snapshotted = 0;
    const host: any = {
      silent: false, agentDepth: 0, tier: 'chat', workspaceRoot: ws, sessionKey: 'w31', ownership: null,
      assertInheritedExecutionAuthorityCurrent: () => {},
      captureFileSnapshot: () => { snapshotted += 1; },
      confirmSilentChildToolApproval: async () => null,
      maybeReindexSource: async () => '',
    };
    // Empty patch is refused.
    await assert.rejects(
      () => invokeBuiltinToolRuntime.call(host, 'apply_patch', { patch: '   ' }),
      /non-empty patch/,
    );
    // Add-file envelope creates the file and snapshots for undo.
    const patch = ['*** Begin Patch', '*** Add File: created.txt', '+line one', '+line two', '*** End Patch'].join('\n');
    const out = await invokeBuiltinToolRuntime.call(host, 'apply_patch', { patch });
    assert.equal(fs.readFileSync(path.join(ws, 'created.txt'), 'utf8'), 'line one\nline two\n');
    assert.equal(snapshotted, 1, 'captured an undo snapshot for the added file');
    assert.ok(typeof out === 'string' && out.length > 0, 'returned a result string');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
