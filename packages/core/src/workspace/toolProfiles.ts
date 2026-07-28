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
import { WORKSPACE_CAPABILITY_DEFINITIONS } from './capabilities.js';
import { getWorkspaceProfile } from './profiles.js';
import { isSelectableWorkspaceCatalogToolId } from './selectionCatalog/toolEligibility.js';
import { WORKSPACE_TOOL_PROFILES } from './toolProfileCatalog.js';

export {
  WORKSPACE_TOOL_PROFILES,
  type WorkspaceToolProfileDefinition,
} from './toolProfileCatalog.js';

export interface WorkspaceToolSelection {
  managed: boolean;
  mode: WorkspaceToolSelectionMode;
  activeProfileIds: string[];
  deniedIds: Set<string>;
  allowedToolIds: Set<string>;
  allowedMcpToolIds: Set<string>;
  allowedExtensionIds: Set<string>;
}

export interface WorkspaceToolDescriptor {
  toolId: string;
  extensionId?: string;
}

export interface WorkspaceMcpToolDescriptor {
  /** Raw server-advertised name, never the connection-specific namespace. */
  toolId: string;
  /** True only when the connected server was identified as BrainRouter. */
  brainrouterOwned: boolean;
}

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
const BASELINE_BRAINROUTER_MCP_TOOL_IDS = new Set([
  'list_skills',
  'get_skill',
  'search_skills',
]);

export function workspaceToolProfileIds(): string[] {
  return WORKSPACE_TOOL_PROFILES.map((profile) => profile.id);
}

/** Resolve reviewed manifest profiles plus task-time capability additions. */
export function resolveWorkspaceToolSelection(input: {
  manifest: Pick<
    WorkspaceManifest,
    'version' | 'profile' | 'capabilities' | 'tools'
  > | null | undefined;
  activeToolProfiles?: readonly string[];
}): WorkspaceToolSelection {
  if (!input.manifest) return emptySelection();

  const mode: WorkspaceToolSelectionMode =
    input.manifest.version === WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION
      && input.manifest.tools.mode === 'explicit-catalog'
      ? 'explicit-catalog'
      : 'legacy-groups';
  const activeToolProfiles = mode === 'explicit-catalog'
    ? reviewedCapabilityToolProfiles(input.manifest, input.activeToolProfiles ?? [])
    : input.activeToolProfiles ?? [];
  const activeProfileIds = unique([
    ...input.manifest.tools.profiles,
    ...activeToolProfiles,
  ]).filter((id) => PROFILE_BY_ID.has(id));
  const allowedToolIds = new Set<string>();
  const allowedMcpToolIds = new Set<string>();
  const allowedExtensionIds = new Set<string>();
  for (const id of activeProfileIds) {
    const profile = PROFILE_BY_ID.get(id)!;
    for (const toolId of profile.toolIds) allowedToolIds.add(toolId);
    for (const toolId of profile.mcpToolIds) allowedMcpToolIds.add(toolId);
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
      for (const toolId of profile.mcpToolIds) deniedIds.add(toolId);
      for (const extensionId of profile.extensionIds) deniedIds.add(extensionId);
    }
  }

  return {
    managed: true,
    mode,
    activeProfileIds,
    deniedIds,
    allowedToolIds,
    allowedMcpToolIds,
    allowedExtensionIds,
  };
}

/**
 * V3 capability choices are reviewed manifest authority, but their tool groups
 * remain task-scoped. Accept only groups contributed by an enabled capability
 * compatible with the selected profile; callers cannot widen an explicit
 * catalog by passing arbitrary active group ids.
 */
function reviewedCapabilityToolProfiles(
  manifest: Pick<WorkspaceManifest, 'profile' | 'capabilities'>,
  requested: readonly string[],
): string[] {
  const profile = getWorkspaceProfile(manifest.profile);
  if (!profile) return [];
  const available = new Set(profile.capabilities.available);
  const disabled = new Set(manifest.capabilities.disabled);
  const enabled = new Set(
    manifest.capabilities.enabled.filter((id) => available.has(id) && !disabled.has(id)),
  );
  const reviewedGroups = new Set(
    WORKSPACE_CAPABILITY_DEFINITIONS
      .filter((capability) => enabled.has(capability.id))
      .flatMap((capability) => [...capability.toolProfileIds]),
  );
  return unique(requested).filter((id) => reviewedGroups.has(id));
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

/**
 * Keep the essential skill library available to every managed profile, then
 * expose only reviewed first-party MCP reads unless the user selected the
 * general MCP surface. Connection-specific names never enter the manifest.
 */
export function workspaceMcpToolAllowed(
  selection: WorkspaceToolSelection,
  descriptor: WorkspaceMcpToolDescriptor,
): boolean {
  if (!selection.managed || selection.mode === 'legacy-groups') return true;
  if (selection.deniedIds.has(descriptor.toolId)) return false;
  if (
    descriptor.brainrouterOwned
    && BASELINE_BRAINROUTER_MCP_TOOL_IDS.has(descriptor.toolId)
  ) {
    return true;
  }
  if (workspaceDynamicMcpAllowed(selection)) return true;
  return descriptor.brainrouterOwned && selection.allowedMcpToolIds.has(descriptor.toolId);
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
    allowedMcpToolIds: new Set(),
    allowedExtensionIds: new Set(),
  };
}
