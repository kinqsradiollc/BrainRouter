/**
 * Manifest tool-profile resolution for one Agent turn.
 *
 * Profiles name product-level tool groups; this registry is the only place
 * those names become concrete extension/tool ids. Resolution never changes the
 * process-global extension registry. A missing manifest is an exact no-op, and
 * tools outside the explicit registry preserve their existing visibility.
 */
import type { WorkspaceManifest } from './manifest.js';

export interface WorkspaceToolProfileDefinition {
  id: string;
  toolIds: readonly string[];
  extensionIds: readonly string[];
}

export interface WorkspaceToolSelection {
  managed: boolean;
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
    toolIds: ['write_file', 'edit_file', 'apply_patch', 'notebook_edit', 'lsp'],
    extensionIds: [],
  },
  {
    id: 'terminal',
    toolIds: ['run_command', 'task_output', 'wait_until', 'kill_command', 'computer_use', 'connector_run'],
    extensionIds: [],
  },
  {
    id: 'browser',
    toolIds: ['fetch_url', 'web_search'],
    extensionIds: [],
  },
  {
    id: 'notes',
    toolIds: ['research_note', 'research_brief', 'artifact_write'],
    extensionIds: [],
  },
  {
    id: 'design',
    toolIds: ['artifact_write'],
    extensionIds: ['browser'],
  },
] as const;

const PROFILE_BY_ID = new Map(WORKSPACE_TOOL_PROFILES.map((profile) => [profile.id, profile]));
const MANAGED_TOOL_IDS = new Set(WORKSPACE_TOOL_PROFILES.flatMap((profile) => [...profile.toolIds]));
const MANAGED_EXTENSION_IDS = new Set(WORKSPACE_TOOL_PROFILES.flatMap((profile) => [...profile.extensionIds]));

export function workspaceToolProfileIds(): string[] {
  return WORKSPACE_TOOL_PROFILES.map((profile) => profile.id);
}

/** Resolve reviewed manifest profiles plus task-time capability additions. */
export function resolveWorkspaceToolSelection(input: {
  manifest: Pick<WorkspaceManifest, 'tools'> | null | undefined;
  activeToolProfiles?: readonly string[];
}): WorkspaceToolSelection {
  if (!input.manifest) return emptySelection();

  const activeProfileIds = unique([
    ...input.manifest.tools.profiles,
    ...(input.activeToolProfiles ?? []),
  ]).filter((id) => PROFILE_BY_ID.has(id));
  const allowedToolIds = new Set<string>();
  const allowedExtensionIds = new Set<string>();
  for (const id of activeProfileIds) {
    const profile = PROFILE_BY_ID.get(id)!;
    for (const toolId of profile.toolIds) allowedToolIds.add(toolId);
    for (const extensionId of profile.extensionIds) allowedExtensionIds.add(extensionId);
  }

  return {
    managed: true,
    activeProfileIds,
    deniedIds: new Set(input.manifest.tools.deny),
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

  const managedByTool = MANAGED_TOOL_IDS.has(descriptor.toolId);
  const managedByExtension = Boolean(
    descriptor.extensionId && MANAGED_EXTENSION_IDS.has(descriptor.extensionId),
  );
  if (!managedByTool && !managedByExtension) return true;

  return selection.allowedToolIds.has(descriptor.toolId)
    || Boolean(descriptor.extensionId && selection.allowedExtensionIds.has(descriptor.extensionId));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function emptySelection(): WorkspaceToolSelection {
  return {
    managed: false,
    activeProfileIds: [],
    deniedIds: new Set(),
    allowedToolIds: new Set(),
    allowedExtensionIds: new Set(),
  };
}
