/**
 * ORCHESTRATION TOOLS — dispatch entrypoint + public surface.
 *
 * The heavy lifting lives in cohesive modules under `./tools/`:
 *   - spawn.ts        — spawn_agent / the child launch + detached runTurn + offload
 *   - wait.ts         — wait/wait_agents/list/read_transcript/close
 *   - continuation.ts — send_input / resume_agent / continueChildAgent
 *   - summarize.ts    — the child-record → JSON summary
 *   - registry.ts     — the SINGLE shared live-agent state (runningPromises /
 *                       runningChildAgents) + interrupt-cascade helpers
 *   - helpers.ts      — clampAccess / previews / role inference / cwd + timeout resolve
 *   - toolNames.ts    — orchestration tool-name set + delegate_<id> synthesis
 *   - context.ts      — the OrchestrationContext shape
 *
 * This file owns `executeOrchestrationTool` (the tool-name switch) plus the thin
 * routing/delegation handlers that are pure glue over `handleSpawn`, and it
 * re-exports the module surface so every importer of `./tools.js` is unchanged.
 */
import { handleSpawn } from './tools/spawn.js';
import { handleList, handleWait, handleWaitBatch, handleReadTranscript, handleClose } from './tools/wait.js';
import { handleSendInput, handleResumeAgent } from './tools/continuation.js';
import { DELEGATE_TOOL_PREFIX, resolveDelegateAgentId, isOrchestrationToolName, synthesizeDelegateTools } from './tools/toolNames.js';
import { DEFAULT_TASK_AGENT_TIMEOUT_MS, inferRoleFromTask, clampAccess, extractChildPreview } from './tools/helpers.js';
import { trackedPromiseFor, childAgentsFor, registerInterruptibleAgent, unregisterInterruptibleAgent } from './tools/registry.js';
import type { OrchestrationContext } from './tools/context.js';
import { resolveRole, type AccessMode } from './roles/roles.js';
import { ownershipRequirementError } from './ownership/ownership.js';
import { listAll } from './agents/agentRegistry.js';
import { runWorkflow } from '../workflow/template/workflowTool.js';
import { loadWorkflowGraph } from '../workflow/graph/graphStore.js';
import { runGraph } from '../workflow/graph/graphEngine.js';
import { routeTask } from './delegation/router.js';
import { localModelProfileActive } from '../provider/modelFamily.js';
import { getCliKnobs } from '../config/config.js';

// ---------------------------------------------------------------------------
// Routing / delegation handlers — thin glue over handleSpawn (foreground vs
// background) plus the router + saved-graph entrypoints. Kept here alongside the
// dispatcher because they are pure orchestration wiring, not child-launch logic.
// ---------------------------------------------------------------------------

async function handleRouteTask(args: any, ctx: OrchestrationContext): Promise<string> {
  const task = String(args?.task ?? '');
  if (!task.trim()) throw new Error('route_task requires `task`.');
  // Snapshot the connected MCP tool set so the router knows whether
  // it can attempt the memory_recall hop.
  let toolNames: Set<string> | undefined;
  try {
    const res = await ctx.mcpClient.listTools();
    toolNames = new Set(((res as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name));
  } catch {
    toolNames = undefined;
  }
  const result = await routeTask({
    task,
    mcpClient: ctx.mcpClient,
    mcpToolNames: toolNames,
    sessionKey: ctx.parentSessionKey,
    // HONK-L6 — bias toward bounded inline tasks when the parent runs a local model.
    localModel: localModelProfileActive(ctx.llmConfig?.model, getCliKnobs().localModelProfile),
  });
  return JSON.stringify(result, null, 2);
}

async function handleTaskAgent(args: any, ctx: OrchestrationContext): Promise<string> {
  return await handleSpawn({ ...args, wait: true, timeoutMs: args?.timeoutMs ?? DEFAULT_TASK_AGENT_TIMEOUT_MS }, ctx);
}

/**
 * §7 L4 — run a saved visual-workflow graph by id. Each `agent` node delegates to
 * the same `task_agent` foreground-spawn path (so the graph's AI work is real
 * child agents, clamped to the parent's access mode), and `subworkflow` nodes load
 * from the same store (the engine's own depth + recursion guard prevents runaway
 * nesting). Returns the graph's final output plus a one-line run summary.
 */
async function handleRunWorkflowGraph(args: any, ctx: OrchestrationContext): Promise<string> {
  const id = String(args?.id ?? args?.workflowId ?? '').trim();
  if (!id) throw new Error('run_workflow_graph requires an `id` — the saved workflow-graph id/name (see the Workflows canvas).');
  const graph = loadWorkflowGraph(ctx.workspaceRoot, id);
  if (!graph) throw new Error(`No saved workflow graph "${id}". Build and save one in the Workflows canvas, or check the id with the desktop's workflow list.`);

  // Seed run vars from the caller's `vars` object over the graph's own defaults.
  const callerVars = args?.vars && typeof args.vars === 'object' && !Array.isArray(args.vars)
    ? (args.vars as Record<string, unknown>)
    : {};
  const seeded = { ...graph, vars: { ...(graph.vars ?? {}), ...callerVars } };

  const result = await runGraph(seeded, {
    runAgent: async (prompt) => {
      const out = await handleTaskAgent({ prompt }, ctx);
      // handleTaskAgent may return raw text or a JSON envelope — surface the text.
      try {
        const j = JSON.parse(out) as Record<string, unknown>;
        if (j && typeof j === 'object') return String(j.output ?? j.raw ?? j.text ?? out);
      } catch { /* raw text */ }
      return out;
    },
    loadSubWorkflow: async (ref) => loadWorkflowGraph(ctx.workspaceRoot, ref),
  });

  if (!result.ok) return `Workflow "${id}" failed: ${result.error ?? 'unknown error'}`;
  const ran = result.order.filter((n) => result.nodes[n]?.status === 'ok').length;
  return `Workflow "${id}" completed (${ran} node${ran === 1 ? '' : 's'} ran).\n\n${result.finalOutput ?? '(no output node produced text)'}`;
}

async function handleDelegateAgent(args: any, ctx: OrchestrationContext): Promise<string> {
  const spawned = await handleSpawn({ ...args, wait: false }, ctx);
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(spawned);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value;
  } catch {
    // not JSON; fall through to verbatim propagation
  }
  // If handleSpawn returned an error string or a non-object payload (no id to
  // attach next-step semantics to), propagate it verbatim — wrapping it in
  // { raw, nextAction } would hide the failure from the model and prevent the
  // child-drain guardrail from finding a child id to wait on.
  if (!parsed || typeof parsed.id !== 'string') return spawned;
  return JSON.stringify({
    ...parsed,
    nextAction: 'continue working in the parent turn; call wait_agent when this child output is needed',
  }, null, 2);
}

async function handleSpawnBatch(args: any, ctx: OrchestrationContext): Promise<string> {
  const list = Array.isArray(args?.agents) ? args.agents : [];
  if (list.length === 0) throw new Error('spawn_agents requires at least one entry in `agents`.');

  // MAS-P3 — ownership gate. Resolve each entry's effective access and
  // refuse write/shell fan-out that declared no ownership glob (parallel
  // writers would otherwise be free to clobber each other's files). This
  // runs BEFORE any child is spawned, so a bad batch fails atomically
  // rather than half-spawning. Read-only fan-out is allowed but noted.
  const roleNames = list.map((entry: any) => entry.role ?? inferRoleFromTask(String(entry.prompt ?? '')));
  const warnings: string[] = [];
  list.forEach((entry: any, i: number) => {
    let effectiveAccess: AccessMode;
    if (entry.access === 'read' || entry.access === 'write' || entry.access === 'shell') {
      effectiveAccess = entry.access;
    } else {
      try {
        effectiveAccess = resolveRole(roleNames[i]).defaultAccess;
      } catch {
        effectiveAccess = 'read';
      }
    }
    const err = ownershipRequirementError(effectiveAccess, entry.ownership, entry.allowOverlap);
    if (err) {
      const who = entry.label ? `"${entry.label}"` : `agents[${i}] (${roleNames[i]})`;
      throw new Error(`spawn_agents: ${who} — ${err}`);
    }
    if (effectiveAccess === 'read' && !entry.ownership) {
      warnings.push(`agents[${i}] (${roleNames[i]}) is read-only with no ownership — fine for reads, but it cannot write.`);
    }
  });

  const results: Array<Record<string, unknown>> = [];
  // Spawn sequentially so each gets a unique session id and createSession's
  // write isn't racy. The CHILDREN themselves still run in parallel — handleSpawn
  // kicks off the runTurn detached via runningPromises.set, then returns.
  for (let i = 0; i < list.length; i++) {
    const out = await handleSpawn({ ...list[i], role: roleNames[i] }, ctx);
    try {
      results.push(JSON.parse(out));
    } catch {
      results.push({ raw: out });
    }
  }
  const payload: Record<string, unknown> = { spawned: results.length, agents: results };
  if (warnings.length > 0) payload.warnings = warnings;
  return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------------
// Dispatcher — the single entrypoint the agent loop calls for every
// orchestration tool. Routes each tool name to its handler (module or local).
// ---------------------------------------------------------------------------

export async function executeOrchestrationTool(
  name: string,
  args: any,
  ctx: OrchestrationContext,
): Promise<string> {
  // MAS-P2-M1: synthesized delegate_<agentId> tools route through
  // task_agent (foreground wait). Resolved against the live registry
  // so an in-session pack swap takes effect on the next call.
  if (name.startsWith(DELEGATE_TOOL_PREFIX) && name !== 'delegate_agent') {
    const loadedDefs = listAll(ctx.workspaceRoot);
    const agentId = resolveDelegateAgentId(name, loadedDefs);
    if (agentId) {
      return await handleTaskAgent({ ...args, agentId }, ctx);
    }
    // Fall through to the unknown-tool error so the loop surfaces it.
  }

  switch (name) {
    case 'task_agent':
      return await handleTaskAgent(args, ctx);
    case 'delegate_agent':
      return await handleDelegateAgent(args, ctx);
    case 'spawn_agent':
      return await handleSpawn(args, ctx);
    case 'spawn_agents':
      return await handleSpawnBatch(args, ctx);
    case 'list_agents':
      return handleList(ctx);
    case 'wait_agent':
      return await handleWait(args, ctx);
    case 'wait_agents':
      return await handleWaitBatch(args, ctx);
    case 'read_agent_transcript':
      return handleReadTranscript(args, ctx);
    case 'close_agent':
      return handleClose(args, ctx);
    case 'send_input':
      return await handleSendInput(args, ctx);
    case 'resume_agent':
      return await handleResumeAgent(args, ctx);
    case 'route_task':
      return await handleRouteTask(args, ctx);
    case 'run_workflow':
      // WF-TOOL — execute a declarative PhasePlan deterministically. Inject this
      // very dispatcher as the spawn backend (run_workflow's children go through
      // the same spawn_agents/wait_agents path everything else does).
      return await runWorkflow(args, ctx, { dispatch: executeOrchestrationTool });
    case 'run_workflow_graph':
      // §7 L4 — run a saved visual-workflow GRAPH. Agent nodes delegate to the
      // same task_agent spawn path; sub-workflow nodes load from the same store.
      return await handleRunWorkflowGraph(args, ctx);
    default:
      throw new Error(`Unknown orchestration tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Public surface — re-export the module APIs so importers of './tools.js' keep
// working unchanged. executeOrchestrationTool is defined above (local).
// ---------------------------------------------------------------------------
export type { OrchestrationContext };
export {
  clampAccess,
  extractChildPreview,
  inferRoleFromTask,
  isOrchestrationToolName,
  synthesizeDelegateTools,
  trackedPromiseFor,
  childAgentsFor,
  registerInterruptibleAgent,
  unregisterInterruptibleAgent,
};
// The per-tool ToolSpec factories live in their own module; keep re-exporting
// them from here so tool/specs.ts and friends import from one stable place.
export {
  createSpawnAgentTool,
  createTaskAgentTool,
  createDelegateAgentTool,
  createListAgentsTool,
  createWaitAgentTool,
  createReadAgentTranscriptTool,
  createCloseAgentTool,
  createSendInputTool,
  createResumeAgentTool,
  createSpawnAgentsTool,
  createWaitAgentsTool,
  createRouteTaskTool,
  createRunWorkflowTool,
  createRunWorkflowGraphTool,
} from './agents/agentTools.js';
