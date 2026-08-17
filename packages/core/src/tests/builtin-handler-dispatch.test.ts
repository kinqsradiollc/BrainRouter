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
