import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_TOOL_REGISTRY,
  registryAllowedTools,
  registryParallelSafeLocal,
  hideWorkerToolsFor,
  WORKER_THREAD_TOOLS,
} from '../tool/registry.js';
import { actionKindForTool } from '../exec/execPolicy.js';
import { isParallelSafe } from '../agent/tools/toolSafety.js';
import { LOCAL_TOOLS } from '../tool/specs.js';
import {
  assertLocalToolExecutorInvariants,
  localToolExecutor,
  localToolExecutors,
  localToolSpecsFromExecutors,
} from '../tool/executors.js';

// Worker-thread tools are now registered (so the model can call them); the only
// remaining unregistered, goal-scoped dynamic specs are these — the spec↔registry
// guard still treats them as known exceptions.
const WORKER_TOOLS = new Set([
  'extract_result', 'workflow_progress',
]);

test('CODEX-TOOL-REGISTRY action kind agrees with execPolicy for every entry', () => {
  for (const t of LOCAL_TOOL_REGISTRY) {
    assert.equal(
      t.actionKind,
      actionKindForTool(t.name),
      `${t.name}: registry actionKind "${t.actionKind}" must equal actionKindForTool "${actionKindForTool(t.name)}"`,
    );
  }
});

test('CODEX-TOOL-REGISTRY parallel-safety agrees with toolSafety for every entry', () => {
  for (const t of LOCAL_TOOL_REGISTRY) {
    assert.equal(
      t.parallelSafe,
      isParallelSafe(t.name),
      `${t.name}: registry parallelSafe=${t.parallelSafe} must equal isParallelSafe=${isParallelSafe(t.name)}`,
    );
  }
  // The generated whitelist is exactly the registry's parallel-safe entries.
  const fromRegistry = registryParallelSafeLocal();
  for (const t of LOCAL_TOOL_REGISTRY) {
    assert.equal(fromRegistry.has(t.name), t.parallelSafe, `${t.name} parallel set membership`);
  }
});

test('CODEX-TOOL-REGISTRY exposure tiers reproduce the historical allowed sets exactly', () => {
  // These are the sets the agent shipped before the registry generated them —
  // the guard ensures the generated exposure never silently changes.
  const read = registryAllowedTools('read');
  const write = registryAllowedTools('write');
  const shell = registryAllowedTools('shell');

  // Tiers are strictly nested: read ⊂ write ⊂ shell.
  for (const t of read) assert.ok(write.has(t), `read tool ${t} must remain in write`);
  for (const t of write) assert.ok(shell.has(t), `write tool ${t} must remain in shell`);

  // Write adds exactly the structured file tools; shell adds command/computer
  // control plus connector_run (network ingestion + memory writes, shell-gated).
  assert.deepEqual([...write].filter((t) => !read.has(t)).sort(), ['apply_patch', 'edit_file', 'write_file']);
  assert.deepEqual([...shell].filter((t) => !write.has(t)).sort(), ['computer_use', 'connector_run', 'run_command']);

  // Read tier exposes the read/observe/orchestration surface and nothing mutating.
  assert.ok(read.has('read_file') && read.has('task_agent') && read.has('goal_complete'));
  assert.ok(!read.has('write_file') && !read.has('run_command'));

  // Connectors: listing is read-tier; running (network + memory writes) is shell-only.
  assert.ok(read.has('connector_list'), 'connector_list is read-tier');
  assert.ok(!read.has('connector_run') && shell.has('connector_run'), 'connector_run is shell-only');
});

test('CODEX-TOOL-REGISTRY every spec\'d local tool is classified (registry or known worker)', () => {
  const registered = new Set(LOCAL_TOOL_REGISTRY.map((t) => t.name));
  for (const spec of LOCAL_TOOLS as Array<{ name?: string }>) {
    const name = spec?.name;
    if (!name) continue;
    assert.ok(
      registered.has(name) || WORKER_TOOLS.has(name),
      `spec'd tool "${name}" has no registry entry — add it to LOCAL_TOOL_REGISTRY (or WORKER_TOOLS if it's a worker tool)`,
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
  const names = LOCAL_TOOL_REGISTRY.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool name in the registry');
});

test('CODEX-TOOL-EXECUTOR one executor exists for every registry entry', () => {
  const registryNames = LOCAL_TOOL_REGISTRY.map((t) => t.name).sort();
  const executorNames = localToolExecutors().map((t) => t.toolName()).sort();
  assert.deepEqual(executorNames, registryNames);
  assertLocalToolExecutorInvariants();
});

test('CODEX-TOOL-EXECUTOR owns spec + policy + parallel metadata together', () => {
  const specs = new Map((LOCAL_TOOLS as Array<{ name: string }>).map((spec) => [spec.name, spec]));
  for (const entry of LOCAL_TOOL_REGISTRY) {
    const executor = localToolExecutor(entry.name);
    assert.ok(executor, `${entry.name} should have an executor`);
    assert.equal(executor.toolName(), entry.name);
    assert.equal(executor.spec(), specs.get(entry.name), `${entry.name} executor should expose the canonical spec object`);
    assert.equal(executor.accessTier(), entry.accessTier);
    assert.equal(executor.actionKind(), entry.actionKind);
    assert.equal(executor.supportsParallelToolCalls(), entry.parallelSafe);
  }
});

test('CODEX-TOOL-EXECUTOR direct specs are generated from executors', () => {
  const executorSpecs = localToolSpecsFromExecutors().map((tool) => tool.name).sort();
  const registryNames = LOCAL_TOOL_REGISTRY.map((tool) => tool.name).sort();
  assert.deepEqual(executorSpecs, registryNames);
});
