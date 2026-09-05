import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registryAllowedTools,
  registryParallelSafeLocal,
  registryToolAllowed,
  hideWorkerToolsFor,
  WORKER_THREAD_TOOLS,
} from '../tool/registry/registry.js';
import { REQUIRED_CORE_TOOL_CATALOG } from '../extension/builtin/toolCatalog.js';
import { BUILTIN_TOOL_SPECS } from '../extension/builtin/toolSpecs.js';
import { extensionToolOwner } from '../extension/registry.js';
import { actionKindForTool } from '../exec/policy/execPolicy.js';
import { isParallelSafe } from '../agent/guards/toolSafety.js';
import {
  assertLocalToolExecutorInvariants,
  localToolExecutor,
  localToolExecutors,
  localToolSpecsFromExecutors,
} from '../tool/registry/executors.js';

test('CODEX-TOOL-REGISTRY action kind agrees with execPolicy for every entry', () => {
  for (const t of REQUIRED_CORE_TOOL_CATALOG) {
    assert.equal(
      t.actionKind,
      actionKindForTool(t.name),
      `${t.name}: registry actionKind "${t.actionKind}" must equal actionKindForTool "${actionKindForTool(t.name)}"`,
    );
  }
});

test('CODEX-TOOL-REGISTRY parallel-safety agrees with toolSafety for every entry', () => {
  for (const t of REQUIRED_CORE_TOOL_CATALOG) {
    assert.equal(
      t.parallelSafe,
      isParallelSafe(t.name),
      `${t.name}: registry parallelSafe=${t.parallelSafe} must equal isParallelSafe=${isParallelSafe(t.name)}`,
    );
  }
  // The generated whitelist is exactly the registry's parallel-safe entries.
  const fromRegistry = registryParallelSafeLocal();
  for (const t of REQUIRED_CORE_TOOL_CATALOG) {
    assert.equal(fromRegistry.has(t.name), t.parallelSafe, `${t.name} parallel set membership`);
  }
});

test('CODEX-TOOL-REGISTRY exposure tiers match the reviewed allowed sets exactly', () => {
  // The guard ensures the generated exposure never silently changes.
  const read = registryAllowedTools('read');
  const write = registryAllowedTools('write');
  const shell = registryAllowedTools('shell');

  // Tiers are strictly nested: read ⊂ write ⊂ shell.
  for (const t of read) assert.ok(write.has(t), `read tool ${t} must remain in write`);
  for (const t of write) assert.ok(shell.has(t), `write tool ${t} must remain in shell`);

  // Write adds exactly the structured file tools (plus ADR-056's diagram_render,
  // which delivers an artifact under .brainrouter/diagrams/); shell adds command,
  // native terminal, and computer control plus connector_run.
  assert.deepEqual([...write].filter((t) => !read.has(t)).sort(), ['apply_patch', 'diagram_render', 'edit_file', 'notebook_edit', 'write_file']);
  assert.deepEqual([...shell].filter((t) => !write.has(t)).sort(), [
    'computer_use', 'connector_run', 'kill_command', 'run_code', 'run_command',
    'terminal_list', 'terminal_read', 'terminal_write',
  ]);

  // Read tier exposes the read/observe/orchestration surface and nothing mutating.
  assert.ok(read.has('read_file') && read.has('task_agent') && read.has('goal_complete'));
  assert.ok(!read.has('write_file') && !read.has('run_command'));

  // Connectors: listing is read-tier; running (network + memory writes) is shell-only.
  assert.ok(read.has('connector_list'), 'connector_list is read-tier');
  assert.ok(!read.has('connector_run') && shell.has('connector_run'), 'connector_run is shell-only');
});

test('CORE-EXT every declared first-party tool has a required extension registration', () => {
  const registered = new Set(REQUIRED_CORE_TOOL_CATALOG.map((t) => t.name));
  for (const spec of BUILTIN_TOOL_SPECS as Array<{ name?: string }>) {
    const name = spec?.name;
    if (!name) continue;
    assert.ok(
      registered.has(name),
      `declared tool "${name}" has no required capability owner`,
    );
  }
});

test('WORKER-EXPOSURE worker tools are registered (read tier) and runtime-gated by depth/tier', () => {
  // Registered now, so the model can call them — all four sit in the read tier.
  for (const name of WORKER_THREAD_TOOLS) {
    assert.ok(registryAllowedTools('read').has(name), `${name} should be a read-tier registered tool`);
  }
  // Visible only to a depth-0, non-worker orchestrator.
  assert.equal(hideWorkerToolsFor(0, 'chat'), false);
  assert.equal(hideWorkerToolsFor(0, 'reasoning'), false);
  assert.equal(hideWorkerToolsFor(0, undefined), false);
  assert.equal(hideWorkerToolsFor(1, 'chat'), true); // any child agent
  assert.equal(hideWorkerToolsFor(0, 'worker'), true); // worker tier (defensive)
  assert.equal(hideWorkerToolsFor(2, 'reasoning'), true);
});

test('WORKER-EXPOSURE filter shows worker tools at depth 0, hides them for child/worker', () => {
  const allNames = localToolSpecsFromExecutors().map((t) => t.name);
  const visibleAt = (depth: number, tier?: string) =>
    allNames.filter((n) => !(hideWorkerToolsFor(depth, tier) && WORKER_THREAD_TOOLS.has(n)));
  const root = visibleAt(0, 'chat');
  for (const w of WORKER_THREAD_TOOLS) assert.ok(root.includes(w), `${w} visible to depth-0 orchestrator`);
  const child = visibleAt(1, 'chat');
  for (const w of WORKER_THREAD_TOOLS) assert.ok(!child.includes(w), `${w} hidden from child agent`);
  const worker = visibleAt(1, 'worker');
  for (const w of WORKER_THREAD_TOOLS) assert.ok(!worker.includes(w), `${w} hidden from worker`);
});

test('CODEX-TOOL-REGISTRY entries are unique', () => {
  const names = REQUIRED_CORE_TOOL_CATALOG.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool name in the registry');
});

test('CODEX-TOOL-EXECUTOR one executor exists for every registry entry', () => {
  const registryNames = REQUIRED_CORE_TOOL_CATALOG.map((t) => t.name).sort();
  const executorNames = localToolExecutors().map((t) => t.toolName()).sort();
  assert.deepEqual(executorNames, registryNames);
  assertLocalToolExecutorInvariants();
});

test('CODEX-TOOL-EXECUTOR owns spec + policy + parallel metadata together', () => {
  const specs = new Map((BUILTIN_TOOL_SPECS as Array<{ name: string }>).map((spec) => [spec.name, spec]));
  for (const entry of REQUIRED_CORE_TOOL_CATALOG) {
    const executor = localToolExecutor(entry.name);
    assert.ok(executor, `${entry.name} should have an executor`);
    assert.equal(executor.toolName(), entry.name);
    assert.equal(executor.spec(), specs.get(entry.name), `${entry.name} executor should expose the canonical spec object`);
    assert.equal(executor.accessTier(), entry.accessTier);
    assert.equal(executor.actionKind(), entry.actionKind);
    assert.equal(executor.supportsParallelToolCalls(), entry.parallelSafe);
  }
});

test('CORE-EXT synthesized delegate names resolve through extension metadata and preserve the invoked name', async () => {
  const executor = localToolExecutor('delegate_reviewer');
  assert.ok(executor);
  assert.equal(executor.toolName(), 'delegate_agent');
  assert.equal(actionKindForTool('delegate_reviewer'), 'child_write');
  assert.equal(registryToolAllowed('delegate_reviewer', 'read'), true);
  assert.equal(isParallelSafe('delegate_reviewer'), true);

  let invoked = '';
  const output = await executor.handle({
    args: { prompt: 'Review this.' },
    invokedName: 'delegate_reviewer',
    orchestrationRuntime: {
      async invoke(name) { invoked = name; return 'delegated'; },
    },
  });
  assert.equal(invoked, 'delegate_reviewer');
  assert.equal(output, 'delegated');
});

test('CODEX-TOOL-EXECUTOR direct specs are generated from executors', () => {
  const executorSpecs = localToolSpecsFromExecutors().map((tool) => tool.name).sort();
  const registryNames = REQUIRED_CORE_TOOL_CATALOG.map((tool) => tool.name).sort();
  assert.deepEqual(executorSpecs, registryNames);
});

test('CORE-EXT every required tool is owned by a required capability extension', () => {
  for (const tool of REQUIRED_CORE_TOOL_CATALOG) {
    const owner = extensionToolOwner(tool.name);
    assert.ok(owner?.required, `${tool.name} must have a required extension owner`);
    assert.notEqual(owner?.extension, 'Agent', `${tool.name} must not be wired directly into Agent`);
  }
});

test('CORE-EXT dynamic visibility belongs to the extension executor', () => {
  const none = localToolSpecsFromExecutors({
    resultExpansionAvailable: false,
    workflowActive: false,
    activeOrchestrationPlan: false,
    terminalUseAvailable: false,
  }).map((tool) => tool.name);
  assert.ok(!none.includes('extract_result'));
  assert.ok(!none.includes('workflow_progress'));
  assert.ok(!none.includes('profile_stage'));
  assert.ok(!none.includes('terminal_read'));
  const active = localToolSpecsFromExecutors({
    resultExpansionAvailable: true,
    workflowActive: true,
    activeOrchestrationPlan: true,
    terminalUseAvailable: true,
  }).map((tool) => tool.name);
  assert.ok(active.includes('extract_result'));
  assert.ok(active.includes('workflow_progress'));
  assert.ok(active.includes('profile_stage'));
  assert.ok(active.includes('terminal_list'));
  assert.ok(active.includes('terminal_read'));
  assert.ok(active.includes('terminal_write'));
});

test('CORE-EXT Agent runtime contains no first-party tool catalog or handler switch', () => {
  const agentRoot = fileURLToPath(new URL('../../src/agent/', import.meta.url));
  const files: string[] = [path.join(agentRoot, 'agent.ts')];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(path.join(agentRoot, 'runtime'));
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const banned of ['LOCAL_' + 'TOOLS', 'LOCAL_' + 'TOOL_REGISTRY', 'executeLocalTool' + 'Legacy']) {
    assert.equal(source.includes(banned), false, `Agent runtime must not reintroduce ${banned}`);
  }
  for (const tool of REQUIRED_CORE_TOOL_CATALOG) {
    assert.equal(source.includes(`case '${tool.name}'`), false, `${tool.name} handler must stay outside Agent runtime`);
  }
});
