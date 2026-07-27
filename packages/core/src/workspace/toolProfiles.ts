/**
 * Manifest tool-profile resolution for one Agent turn.
 *
 * Profiles name product-level tool groups; this registry is the only place
 * those names become concrete extension/tool ids. Resolution never changes the
 * process-global extension registry. A missing manifest is an exact no-op, and
 * tools outside the explicit registry preserve their existing visibility.
 */
import {
  WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION,
  type WorkspaceManifest,
  type WorkspaceToolSelectionMode,
} from './manifest.js';
import { isSelectableWorkspaceCatalogToolId } from './selectionCatalog/toolEligibility.js';

export interface WorkspaceToolProfileDefinition {
  id: string;
  label: string;
  description: string;
  category: string;
  toolIds: readonly string[];
  extensionIds: readonly string[];
}

export interface WorkspaceToolSelection {
  managed: boolean;
  mode: WorkspaceToolSelectionMode;
  activeProfileIds: string[];
  deniedIds: Set<string>;
  allowedToolIds: Set<string>;
  allowedExtensionIds: Set<string>;
}

export interface WorkspaceToolDescriptor {
  toolId: string;
  extensionId?: string;
}

export const WORKSPACE_TOOL_PROFILES: readonly WorkspaceToolProfileDefinition[] = [
  {
    id: 'coding',
    label: 'Files and code',
    description: 'Inspect, edit, patch, and analyze source files and notebooks.',
    category: 'files-code',
    toolIds: [
      'read_file', 'list_dir', 'grep_search', 'glob_files',
      'write_file', 'edit_file', 'apply_patch', 'notebook_edit', 'lsp',
    ],
    extensionIds: [],
  },
  {
    id: 'shell',
    label: 'Shell commands',
    description: 'Run workspace commands and inspect or control an available native terminal.',
    category: 'terminal-computer',
    toolIds: ['run_command', 'task_output', 'wait_until', 'kill_command', 'terminal_list', 'terminal_read', 'terminal_write'],
    extensionIds: [],
  },
  {
    id: 'browser',
    label: 'Web and research',
    description: 'Fetch web pages and search public sources.',
    category: 'web-research',
    toolIds: ['fetch_url', 'web_search'],
    extensionIds: [],
  },
  {
    id: 'research-notes',
    label: 'Research notes',
    description: 'Capture sourced research notes and bounded research briefs.',
    category: 'notes-artifacts',
    toolIds: ['research_note', 'research_brief'],
    extensionIds: [],
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    description: 'Create structured artifact records for designs, reports, learning materials, and other deliverables.',
    category: 'notes-artifacts',
    toolIds: ['artifact_write'],
    extensionIds: [],
  },
  {
    id: 'planning-session',
    label: 'Planning and session state',
    description: 'Maintain plans, goals, task tracking, chapter markers, and bounded user choices.',
    category: 'planning-session',
    toolIds: [
      'update_plan', 'goal_complete', 'goal_blocked',
      'track_query', 'track_update', 'mark_chapter', 'ask_user_choice',
    ],
    extensionIds: [],
  },
  {
    id: 'orchestration',
    label: 'Active-turn orchestration',
    description: 'Route tasks and coordinate bounded child agents while the owning turn is active.',
    category: 'orchestration-workflows',
    toolIds: [
      'task_agent', 'delegate_agent', 'list_agents', 'wait_agent', 'wait_agents',
      'read_agent_transcript', 'close_agent', 'send_input', 'resume_agent', 'route_task',
    ],
    extensionIds: [],
  },
  {
    id: 'interactive-browser',
    label: 'Interactive browser control',
    description: 'Use tools contributed by the installed browser-control extension when its runtime is available.',
    category: 'design-browser',
    toolIds: [],
    extensionIds: ['browser'],
  },
  {
    id: 'mcp-resources',
    label: 'MCP resources',
    description: 'Discover configured MCP resources and use stable progressive-discovery controls.',
    category: 'mcp-connectors',
    toolIds: [
      'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
      'mcp_search', 'mcp_describe', 'mcp_call', 'mcp_refresh_catalog',
    ],
    extensionIds: [],
  },
  {
    id: 'connectors',
    label: 'Connectors',
    description: 'List configured connectors and run an explicitly authorized connector.',
    category: 'mcp-connectors',
    toolIds: ['connector_list', 'connector_run'],
    extensionIds: [],
  },
  {
    id: 'computer-control',
    label: 'Computer control',
    description: 'Operate an available computer-control session under its normal runtime and approval gates.',
    category: 'terminal-computer',
    toolIds: ['computer_use'],
    extensionIds: [],
  },
  {
    id: 'workflow-launch',
    label: 'Workflow launch',
    description: 'Launch reviewed workflows or saved graphs and inspect active workflow progress.',
    category: 'orchestration-workflows',
    toolIds: ['run_workflow', 'run_workflow_graph', 'workflow_progress'],
    extensionIds: [],
  },
  {
    id: 'background-workers',
    label: 'Background workers',
    description: 'Launch and manage durable root-owned worker threads that may outlive an interactive turn.',
    category: 'orchestration-workflows',
    toolIds: ['spawn_worker_thread', 'wait_worker', 'read_worker_summary', 'close_worker'],
    extensionIds: [],
  },
  {
    id: 'pull-request-observation',
    label: 'Pull request monitoring',
    description: 'Watch pull-request checks, reviews, and comments in the background and notify the active agent when action is needed.',
    category: 'development-lifecycle',
    toolIds: [],
    extensionIds: ['pull-request-observer'],
  },
  {
    id: 'security-review',
    label: 'Security review',
    description: 'Inspect isolated review traffic and record or finalize security findings.',
    category: 'security-review',
    toolIds: [
      'file_vulnerability', 'finish_scan', 'list_requests', 'view_request',
      'repeat_request', 'list_sitemap', 'scope_rules',
    ],
    extensionIds: [],
  },
  {
    id: 'terminal',
    label: 'Compatibility: terminal, computer, and connectors',
    description: 'Existing composite bundle retained unchanged for previously reviewed workspaces.',
    category: 'legacy-compatibility',
    toolIds: ['run_command', 'task_output', 'wait_until', 'kill_command', 'terminal_list', 'terminal_read', 'terminal_write', 'computer_use', 'connector_run'],
    extensionIds: [],
  },
  {
    id: 'notes',
    label: 'Compatibility: notes and artifacts',
    description: 'Existing composite bundle retained unchanged for previously reviewed workspaces.',
    category: 'legacy-compatibility',
    toolIds: ['research_note', 'research_brief', 'artifact_write'],
    extensionIds: [],
  },
  {
    id: 'design',
    label: 'Compatibility: artifacts and browser control',
    description: 'Existing composite bundle retained unchanged for previously reviewed workspaces.',
    category: 'legacy-compatibility',
    toolIds: ['artifact_write'],
    extensionIds: ['browser'],
  },
] as const;

const PROFILE_BY_ID = new Map(WORKSPACE_TOOL_PROFILES.map((profile) => [profile.id, profile]));
// V2 compatibility: these are exactly the tool IDs managed before catalog-backed
// selection. New explicit group expansions must not narrow a legacy workspace.
const LEGACY_MANAGED_TOOL_IDS = new Set([
  'write_file', 'edit_file', 'apply_patch', 'notebook_edit', 'lsp',
  'run_command', 'task_output', 'wait_until', 'kill_command', 'terminal_list', 'terminal_read', 'terminal_write', 'computer_use', 'connector_run',
  'fetch_url', 'web_search', 'research_note', 'research_brief', 'artifact_write',
]);
const MANAGED_EXTENSION_IDS = new Set(WORKSPACE_TOOL_PROFILES.flatMap((profile) => [...profile.extensionIds]));
const MCP_SURFACE_TOOL_IDS = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'mcp_search',
  'mcp_describe',
  'mcp_call',
  'mcp_refresh_catalog',
]);

export function workspaceToolProfileIds(): string[] {
  return WORKSPACE_TOOL_PROFILES.map((profile) => profile.id);
}

/** Resolve reviewed manifest profiles plus task-time capability additions. */
export function resolveWorkspaceToolSelection(input: {
  manifest: Pick<WorkspaceManifest, 'version' | 'tools'> | null | undefined;
  activeToolProfiles?: readonly string[];
}): WorkspaceToolSelection {
  if (!input.manifest) return emptySelection();

  const mode: WorkspaceToolSelectionMode =
    input.manifest.version === WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION
      && input.manifest.tools.mode === 'explicit-catalog'
      ? 'explicit-catalog'
      : 'legacy-groups';
  const activeProfileIds = unique([
    ...input.manifest.tools.profiles,
    ...(mode === 'legacy-groups' ? input.activeToolProfiles ?? [] : []),
  ]).filter((id) => PROFILE_BY_ID.has(id));
  const allowedToolIds = new Set<string>();
  const allowedExtensionIds = new Set<string>();
  for (const id of activeProfileIds) {
    const profile = PROFILE_BY_ID.get(id)!;
    for (const toolId of profile.toolIds) allowedToolIds.add(toolId);
    for (const extensionId of profile.extensionIds) allowedExtensionIds.add(extensionId);
  }
  if (mode === 'explicit-catalog') {
    for (const toolId of input.manifest.tools.enabled ?? []) {
      if (isSelectableWorkspaceCatalogToolId(toolId)) allowedToolIds.add(toolId);
    }
  }

  const deniedIds = new Set(
    mode === 'explicit-catalog'
      ? input.manifest.tools.deny.filter((id) =>
          PROFILE_BY_ID.has(id) || isSelectableWorkspaceCatalogToolId(id))
      : input.manifest.tools.deny,
  );
  if (mode === 'explicit-catalog') {
    for (const id of input.manifest.tools.deny) {
      const profile = PROFILE_BY_ID.get(id);
      if (!profile) continue;
      for (const toolId of profile.toolIds) deniedIds.add(toolId);
      for (const extensionId of profile.extensionIds) deniedIds.add(extensionId);
    }
  }

  return {
    managed: true,
    mode,
    activeProfileIds,
    deniedIds,
    allowedToolIds,
    allowedExtensionIds,
  };
}

/**
 * Apply the tool-profile gate after access/role gates and before user overrides.
 * Denies match either a concrete tool id or its extension id and always win.
 */
export function workspaceToolAllowed(
  selection: WorkspaceToolSelection,
  descriptor: WorkspaceToolDescriptor,
): boolean {
  if (!selection.managed) return true;
  if (selection.deniedIds.has(descriptor.toolId)) return false;
  if (descriptor.extensionId && selection.deniedIds.has(descriptor.extensionId)) return false;

  if (selection.mode === 'explicit-catalog') {
    return selection.allowedToolIds.has(descriptor.toolId)
      || Boolean(descriptor.extensionId && selection.allowedExtensionIds.has(descriptor.extensionId));
  }

  const managedByTool = LEGACY_MANAGED_TOOL_IDS.has(descriptor.toolId);
  const managedByExtension = Boolean(
    descriptor.extensionId && MANAGED_EXTENSION_IDS.has(descriptor.extensionId),
  );
  if (!managedByTool && !managedByExtension) return true;

  return selection.allowedToolIds.has(descriptor.toolId)
    || Boolean(descriptor.extensionId && selection.allowedExtensionIds.has(descriptor.extensionId));
}

/**
 * Dynamic MCP/server tool names are never persisted. V3 opens their live
 * surface only through a reviewed stable MCP control entry; v2 and no-manifest
 * workspaces retain their existing behavior.
 */
export function workspaceDynamicMcpAllowed(selection: WorkspaceToolSelection): boolean {
  if (!selection.managed || selection.mode === 'legacy-groups') return true;
  return [...MCP_SURFACE_TOOL_IDS].some(
    (toolId) => selection.allowedToolIds.has(toolId) && !selection.deniedIds.has(toolId),
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function emptySelection(): WorkspaceToolSelection {
  return {
    managed: false,
    mode: 'legacy-groups',
    activeProfileIds: [],
    deniedIds: new Set(),
    allowedToolIds: new Set(),
    allowedExtensionIds: new Set(),
  };
}
