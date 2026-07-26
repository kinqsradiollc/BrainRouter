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
    id: 'terminal',
    label: 'Terminal and computer control',
    description: 'Run and monitor commands, connectors, and available computer-control sessions.',
    category: 'terminal-computer',
    toolIds: ['run_command', 'task_output', 'wait_until', 'kill_command', 'computer_use', 'connector_run'],
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
    id: 'notes',
    label: 'Notes and artifacts',
    description: 'Capture research notes, briefs, and structured artifacts.',
    category: 'notes-artifacts',
    toolIds: ['research_note', 'research_brief', 'artifact_write'],
    extensionIds: [],
  },
  {
    id: 'design',
    label: 'Design and browser interaction',
    description: 'Create visual artifacts and use the installed browser-control extension.',
    category: 'design-browser',
    toolIds: ['artifact_write'],
    extensionIds: ['browser'],
  },
] as const;

const PROFILE_BY_ID = new Map(WORKSPACE_TOOL_PROFILES.map((profile) => [profile.id, profile]));
// V2 compatibility: these are exactly the tool IDs managed before catalog-backed
// selection. New explicit group expansions must not narrow a legacy workspace.
const LEGACY_MANAGED_TOOL_IDS = new Set([
  'write_file', 'edit_file', 'apply_patch', 'notebook_edit', 'lsp',
  'run_command', 'task_output', 'wait_until', 'kill_command', 'computer_use', 'connector_run',
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
    for (const toolId of input.manifest.tools.enabled ?? []) allowedToolIds.add(toolId);
  }

  const deniedIds = new Set(input.manifest.tools.deny);
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
