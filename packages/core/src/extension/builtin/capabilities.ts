import type { LocalToolExecutor, LocalToolInvocation, LocalToolSpec, ToolExposure } from '../../tool/registry/executors.js';
import type { LocalToolEntry } from '../../tool/registry/registry.js';
import { OrchestrationRuntimeUnavailableError } from '../../orchestration/runtime/activeTurnRuntime.js';
import { extensionToolEntries, registerExtensionTool, requiredExtensionToolNames } from '../registry.js';
import { BUILTIN_TOOL_SPECS } from './toolSpecs.js';
import { REQUIRED_CORE_TOOL_CATALOG } from './toolCatalog.js';

export type BuiltinCapabilityName = keyof typeof CAPABILITY_TOOLS;

export interface BuiltinToolRuntimePort {
  invoke(toolName: string, args: Record<string, any>): Promise<string>;
}

const CAPABILITY_TOOLS = {
  filesystem: ['read_file', 'list_dir', 'grep_search', 'glob_files', 'write_file', 'edit_file', 'apply_patch', 'notebook_edit', 'worktree_list', 'worktree_enter', 'worktree_create', 'worktree_done',
    // ADR-048 S6 — the codebase map is workspace understanding, the same surface
    // area as reading/searching the tree it summarizes.
    'atlas_context',
    // ADR-056 D-A5 — diagrams are workspace artifacts authored from (and verified
    // against) the tree, the same surface area as the map that seeds them.
    'diagram_validate', 'diagram_draft', 'diagram_render'],
  shell: ['run_command', 'run_code', 'task_output', 'wait_until', 'computer_use', 'kill_command', 'terminal_list', 'terminal_read', 'terminal_write'],
  'web-research': ['fetch_url', 'web_search', 'research_note', 'research_brief'],
  'mcp-lsp-connectors': ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'mcp_search', 'mcp_describe', 'mcp_call', 'mcp_refresh_catalog', 'lsp', 'connector_list', 'connector_run'],
  // ADR-028 D6 — the planner joins planning-state: it is the same capability
  // (what the user has decided to do), not a new surface area.
  'planning-state': ['reconcile_steer', 'update_plan', 'goal_complete', 'goal_blocked', 'ask_user_choice', 'track_query', 'track_update', 'artifact_write', 'mark_chapter', 'notify_when_idle', 'switch_model', 'planner_today', 'planner_find', 'planner_add', 'planner_schedule', 'planner_complete',
    // ADR-029 C3 — the workspace verbs join the same capability for the same
    // reason the planner did: they are about what the user has decided and
    // written down, across surfaces, not a new area of authority.
    'workspace_resolve', 'workspace_create', 'workspace_update', 'workspace_link',
    // ADR-041 A41-16 — `remind` is decided-intent state (a thing the agent chose to
    // be reminded of), the same family as the planner and goal verbs above.
    'remind'],
  'security-review': ['file_vulnerability', 'finish_scan', 'list_requests', 'view_request', 'repeat_request', 'list_sitemap', 'scope_rules'],
  orchestration: ['profile_stage', 'task_agent', 'delegate_agent', 'spawn_agent', 'spawn_agents', 'list_agents', 'wait_agent', 'wait_agents', 'read_agent_transcript', 'close_agent', 'send_input', 'resume_agent', 'route_task', 'session_list', 'session_read', 'session_search', 'session_reference'],
  'workflow-workers': ['run_workflow', 'run_workflow_graph', 'workflow_progress', 'extract_result', 'spawn_worker_thread', 'wait_worker', 'read_worker_summary', 'close_worker'],
} as const;

// Build these lazily. Orchestration spec factories import Agent-facing modules,
// so eager module evaluation would create an ESM initialization cycle.
const specsByName = () => new Map((BUILTIN_TOOL_SPECS as LocalToolSpec[]).map((spec) => [spec.name, spec]));
const entriesByName = () => new Map(REQUIRED_CORE_TOOL_CATALOG.map((entry) => [entry.name, entry]));

class BuiltinToolExecutor implements LocalToolExecutor {
  constructor(private readonly toolSpec: LocalToolSpec, private readonly entry: LocalToolEntry) {}
  toolName(): string { return this.entry.name; }
  spec(): LocalToolSpec { return this.toolSpec; }
  exposure(): ToolExposure { return 'direct'; }
  accessTier() { return this.entry.accessTier; }
  actionKind() { return this.entry.actionKind; }
  supportsParallelToolCalls(): boolean { return this.entry.parallelSafe; }
  isAvailable(context: import('../../tool/registry/executors.js').LocalToolAvailabilityContext): boolean {
    if (this.entry.advertised === false) return false;
    if (this.entry.availability === 'result-cache') return context.resultExpansionAvailable === true;
    if (this.entry.availability === 'active-workflow') return context.workflowActive === true;
    if (this.entry.availability === 'active-orchestration-plan') return context.activeOrchestrationPlan === true;
    if (this.entry.availability === 'root-agent') return context.rootAgent === true;
    if (this.entry.availability === 'computer-use') return context.computerUseAvailable === true;
    if (this.entry.availability === 'browser-use') return context.browserUseAvailable === true;
    if (this.entry.availability === 'terminal-use') return context.terminalUseAvailable === true;
    if (this.entry.availability === 'multi-profile') return context.multiProfile === true;
    if (this.entry.availability === 'mcp-discovery') return context.mcpDiscovery === true;
    return true;
  }
  async handle(invocation: LocalToolInvocation): Promise<string> {
    let output: string;
    const invokedName = invocation.invokedName ?? this.entry.name;
    if (this.entry.runtimePort === 'orchestration') {
      if (!invocation.orchestrationRuntime) {
        throw new OrchestrationRuntimeUnavailableError(invokedName, 'missing-port');
      }
      output = await invocation.orchestrationRuntime.invoke(invokedName, invocation.args, { workflowLaunch: this.entry.workflowLaunch === true });
    } else {
      if (!invocation.builtinRuntime) throw new Error(`${this.entry.name}: required core extension has no runtime context.`);
      output = await invocation.builtinRuntime.invoke(invokedName, invocation.args);
    }
    if (this.entry.afterInvoke && invocation.lifecycleRuntime) await invocation.lifecycleRuntime.afterInvoke(this.entry.afterInvoke, invocation.args);
    return output;
  }
}

export function builtinCapabilityNames(): BuiltinCapabilityName[] {
  return Object.keys(CAPABILITY_TOOLS) as BuiltinCapabilityName[];
}

export function registerBuiltinCapability(name: string): void {
  const names = CAPABILITY_TOOLS[name as BuiltinCapabilityName];
  if (!names) throw new Error(`Unknown required core capability extension: ${name}`);
  const specByName = specsByName();
  const entryByName = entriesByName();
  for (const toolName of names) {
    const spec = specByName.get(toolName);
    const entry = entryByName.get(toolName);
    if (!spec || !entry) throw new Error(`${name}: incomplete required tool declaration for ${toolName}`);
    registerExtensionTool(entry, new BuiltinToolExecutor(spec, entry), name, { required: true });
  }
}

/** Source/test fallback: required capabilities exist before optional extension discovery runs. */
export function ensureRequiredCoreToolsRegistered(): void {
  const required = requiredExtensionToolNames();
  const current = extensionToolEntries();
  if (current.length >= REQUIRED_CORE_TOOL_CATALOG.length && REQUIRED_CORE_TOOL_CATALOG.every((tool) => required.has(tool.name))) return;
  for (const capability of builtinCapabilityNames()) registerBuiltinCapability(capability);
  const missing = REQUIRED_CORE_TOOL_CATALOG.filter((tool) => !requiredExtensionToolNames().has(tool.name));
  if (missing.length) throw new Error(`Required core tool activation incomplete: ${missing.map((tool) => tool.name).join(', ')}`);
}

export function requiredCoreCapabilityCatalog(): Readonly<Record<BuiltinCapabilityName, readonly string[]>> {
  return CAPABILITY_TOOLS;
}
