import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_TOOL_REGISTRY,
  registryAllowedTools,
  registryParallelSafeLocal,
} from '../agent/tools/registry.js';
import { actionKindForTool } from '../runtime/exec/execPolicy.js';
import { isParallelSafe } from '../agent/toolSafety.js';
import { LOCAL_TOOLS } from '../agent/tools/specs.js';
import {
  assertLocalToolExecutorInvariants,
  localToolExecutor,
  localToolExecutors,
  localToolSpecsFromExecutors,
} from '../agent/tools/executors.js';

// Worker tools are a separate, goal-scoped dynamic surface — not access-gated
// through the registry, so the spec↔registry guard treats them as known.
const WORKER_TOOLS = new Set([
  'spawn_worker_thread', 'wait_worker', 'close_worker', 'read_worker_summary',
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

  // Write adds exactly the structured file tools; shell adds exactly run_command.
  assert.deepEqual([...write].filter((t) => !read.has(t)).sort(), ['apply_patch', 'edit_file', 'write_file']);
  assert.deepEqual([...shell].filter((t) => !write.has(t)).sort(), ['run_command']);

  // Read tier exposes the read/observe/orchestration surface and nothing mutating.
  assert.ok(read.has('read_file') && read.has('task_agent') && read.has('goal_complete'));
  assert.ok(!read.has('write_file') && !read.has('run_command'));
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
