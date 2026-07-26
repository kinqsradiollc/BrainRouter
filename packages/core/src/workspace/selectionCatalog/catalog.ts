import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionToolOwner } from '../../extension/registry.js';
import {
  effectiveToolRegistry,
  type LocalToolEntry,
} from '../../tool/registry/registry.js';
import { localToolExecutors } from '../../tool/registry/executors.js';
import {
  inspectWorkspaceProfilePlugins,
} from '../profilePlugins.js';
import { BUNDLED_WORKSPACE_SKILL_PACK_IDS } from '../skillSelection.js';
import { WORKSPACE_TOOL_PROFILES } from '../toolProfiles.js';
import { labelForId, pushCatalogEntry, safeCatalogText, safeProvenance } from './safety.js';
import {
  readContributedSkillCatalogRoot,
  readSkillCatalogRoot,
  readSkillFile,
} from './skillMetadata.js';
import { isSelectableWorkspaceCatalogToolId } from './toolEligibility.js';
import {
  WORKSPACE_SELECTION_CATALOG_MAX_ENTRIES,
  WORKSPACE_SELECTION_STABLE_ID,
  type WorkspaceSelectionCatalog,
  type WorkspaceSelectionCatalogEntry,
  type WorkspaceSelectionCatalogOptions,
} from './types.js';

const BUNDLED_SKILLS_ROOT = fileURLToPath(new URL('../../../skills', import.meta.url));
const MAX_CONTRIBUTED_SKILL_ENTRIES = 128;

/** Build a fresh, bounded snapshot from the registries used by the runtime. */
export function buildWorkspaceSelectionCatalog(
  options: WorkspaceSelectionCatalogOptions = {},
): WorkspaceSelectionCatalog {
  const entries: WorkspaceSelectionCatalogEntry[] = [];
  const executors = new Map(localToolExecutors().map((executor) => [executor.toolName(), executor]));
  const plugins = inspectWorkspaceProfilePlugins();
  const packageSkillIds = new Set([
    ...plugins.available.flatMap((plugin) => [...plugin.skillIds]),
    ...plugins.unavailable.flatMap((plugin) => [...plugin.skillIds]),
  ]);

  for (const profile of WORKSPACE_TOOL_PROFILES) {
    pushCatalogEntry(entries, {
      id: profile.id,
      kind: 'tool-group',
      label: profile.label,
      description: profile.description,
      category: profile.category,
      source: 'core',
      provenance: 'workspace-tool-groups',
      persistable: true,
      selectable: true,
      runtimeAvailabilityPrerequisites: [],
      expandsTo: [...profile.toolIds, ...profile.extensionIds.map((id) => `extension:${id}`)],
    });
  }

  for (const tool of effectiveToolRegistry()) {
    const executor = executors.get(tool.name);
    const owner = extensionToolOwner(tool.name);
    const required = owner?.required === true;
    const hidden = !isSelectableWorkspaceCatalogToolId(tool.name);
    const unavailable = options.availability !== undefined
      && executor?.isAvailable?.(options.availability) === false;
    const blockedReason = hidden
      ? 'Internal runtime tool; not directly selectable.'
      : unavailable
        ? availabilityReason(tool)
        : undefined;
    pushCatalogEntry(entries, {
      id: tool.name,
      kind: 'tool',
      label: labelForId(tool.name),
      description: safeCatalogText(executor?.spec().description, 'No description available.'),
      category: categoryForTool(tool),
      source: required ? 'core' : 'extension',
      provenance: safeProvenance(owner?.extension, required ? 'core' : 'installed-extension'),
      persistable: !tool.dynamicNamePrefix || WORKSPACE_SELECTION_STABLE_ID.test(tool.name),
      selectable: blockedReason === undefined,
      ...(blockedReason ? { blockedReason } : {}),
      accessTier: tool.accessTier,
      actionKind: tool.actionKind,
      ...(owner?.extension
        ? { requiredCapabilityOrExtension: safeProvenance(owner.extension, 'extension') }
        : {}),
      runtimeAvailabilityPrerequisites: [
        ...(tool.availability ? [tool.availability] : []),
        ...(tool.runtimePort ? [`runtime:${tool.runtimePort}`] : []),
      ],
    });
  }

  const knownSkillIds = new Set<string>();
  let contributedSkillEntries = 0;
  const contributedRoots = [...(options.contributedSkillRoots ?? [])]
    .sort((left, right) =>
      Number(right.selectable) - Number(left.selectable)
      || left.pluginName.localeCompare(right.pluginName)
      || left.path.localeCompare(right.path));
  const addContributedRoot = (root: typeof contributedRoots[number]): void => {
    for (const skill of readContributedSkillCatalogRoot(root.path)) {
      if (contributedSkillEntries >= MAX_CONTRIBUTED_SKILL_ENTRIES) break;
      if (packageSkillIds.has(skill.id)) continue;
      if (knownSkillIds.has(skill.id)) continue;
      knownSkillIds.add(skill.id);
      contributedSkillEntries += 1;
      const blockedReason = root.selectable
        ? undefined
        : safeCatalogText(root.blockedReason, 'Plugin is disabled.');
      pushCatalogEntry(entries, {
        id: skill.id,
        kind: 'skill',
        label: skill.label,
        description: skill.description,
        category: skill.category,
        source: 'plugin',
        provenance: safeProvenance(root.pluginName, 'plugin'),
        persistable: true,
        selectable: blockedReason === undefined,
        ...(blockedReason ? { blockedReason } : {}),
        requiredCapabilityOrExtension: safeProvenance(root.pluginName, 'plugin'),
        runtimeAvailabilityPrerequisites: blockedReason ? ['plugin-enabled'] : [],
      });
    }
  };
  for (const root of contributedRoots.filter((candidate) => candidate.selectable)) {
    addContributedRoot(root);
  }

  const bundledSkills = readSkillCatalogRoot(BUNDLED_SKILLS_ROOT);
  for (const skill of bundledSkills) {
    if (knownSkillIds.has(skill.id)) continue;
    knownSkillIds.add(skill.id);
    pushCatalogEntry(entries, {
      id: skill.id,
      kind: 'skill',
      label: skill.label,
      description: skill.description,
      category: skill.category,
      source: 'bundled',
      provenance: 'bundled-skills',
      persistable: true,
      selectable: true,
      runtimeAvailabilityPrerequisites: [],
    });
  }
  // Disabled plugin metadata remains discoverable but cannot shadow the
  // enabled/bundled skill that the runtime would actually resolve.
  for (const root of contributedRoots.filter((candidate) => !candidate.selectable)) {
    addContributedRoot(root);
  }
  for (const packId of BUNDLED_WORKSPACE_SKILL_PACK_IDS) {
    pushCatalogEntry(entries, {
      id: packId,
      kind: 'skill-pack',
      label: labelForId(packId),
      description: 'Bundled skills recommended for this workspace profile.',
      category: 'skill-packs',
      source: 'bundled',
      provenance: 'bundled-skills',
      persistable: true,
      selectable: true,
      runtimeAvailabilityPrerequisites: [],
      expandsTo: bundledSkills.map((skill) => skill.id),
    });
  }

  for (const plugin of plugins.available) {
    const source = plugin.kind === 'capability' ? 'capability-plugin' : 'profile-plugin';
    pushCatalogEntry(entries, {
      id: plugin.id,
      kind: 'skill-pack',
      label: labelForId(plugin.id),
      description: plugin.kind === 'capability'
        ? 'Installed task-specific capability skill pack.'
        : 'Installed workspace-profile skill pack.',
      category: 'skill-packs',
      source,
      provenance: safeProvenance(plugin.pluginName, 'installed-plugin'),
      persistable: true,
      selectable: true,
      runtimeAvailabilityPrerequisites: plugin.kind === 'capability'
        ? [`capability:${plugin.id}`]
        : [],
      expandsTo: [...plugin.skillIds],
    });
    for (const id of plugin.skillIds) {
      if (knownSkillIds.has(id)) continue;
      knownSkillIds.add(id);
      const skill = readSkillFile(
        path.join(plugin.skillsRoot, id, 'SKILL.md'),
        id,
        plugin.id,
        plugin.skillsRoot,
      );
      pushCatalogEntry(entries, {
        id,
        kind: 'skill',
        label: skill?.label ?? labelForId(id),
        description: skill?.description ?? 'Installed plugin skill.',
        category: skill?.category ?? plugin.id,
        source,
        provenance: safeProvenance(plugin.pluginName, 'installed-plugin'),
        persistable: true,
        selectable: true,
        requiredCapabilityOrExtension: plugin.id,
        runtimeAvailabilityPrerequisites: plugin.kind === 'capability'
          ? [`capability:${plugin.id}`]
          : [],
      });
    }
  }
  for (const plugin of plugins.unavailable) {
    const source = plugin.kind === 'capability' ? 'capability-plugin' : 'profile-plugin';
    const reason = safeCatalogText(plugin.reason, 'Plugin is unavailable.');
    pushCatalogEntry(entries, {
      id: plugin.id,
      kind: 'skill-pack',
      label: labelForId(plugin.id),
      description: 'Known workspace skill pack.',
      category: 'skill-packs',
      source,
      provenance: safeProvenance(plugin.pluginName, 'plugin'),
      persistable: true,
      selectable: false,
      blockedReason: reason,
      runtimeAvailabilityPrerequisites: [],
      expandsTo: [...plugin.skillIds],
    });
    for (const id of plugin.skillIds) {
      pushCatalogEntry(entries, {
        id,
        kind: 'skill',
        label: labelForId(id),
        description: 'Known plugin skill.',
        category: plugin.id,
        source,
        provenance: safeProvenance(plugin.pluginName, 'plugin'),
        persistable: true,
        selectable: false,
        blockedReason: reason,
        requiredCapabilityOrExtension: plugin.id,
        runtimeAvailabilityPrerequisites: [],
      });
    }
  }

  for (const runtimeTool of options.runtimeTools ?? []) {
    if (!WORKSPACE_SELECTION_STABLE_ID.test(runtimeTool.id)) continue;
    pushCatalogEntry(entries, {
      id: runtimeTool.id,
      kind: 'runtime-tool',
      label: safeCatalogText(runtimeTool.label, labelForId(runtimeTool.id)),
      description: safeCatalogText(runtimeTool.description, 'Live runtime-discovered tool.'),
      category: safeCatalogText(runtimeTool.category, 'mcp-runtime'),
      source: 'runtime',
      provenance: 'live-runtime',
      persistable: false,
      selectable: false,
      blockedReason: 'Live runtime tools are not durable manifest selections.',
      runtimeAvailabilityPrerequisites: ['active-mcp-session'],
    });
  }

  const ordered = entries
    .slice(0, WORKSPACE_SELECTION_CATALOG_MAX_ENTRIES)
    .sort((left, right) =>
      left.kind.localeCompare(right.kind)
      || left.category.localeCompare(right.category)
      || left.label.localeCompare(right.label)
      || left.id.localeCompare(right.id));
  return { entries: ordered, fingerprint: catalogFingerprint(ordered) };
}

function catalogFingerprint(entries: readonly WorkspaceSelectionCatalogEntry[]): string {
  const authorityShape = entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    source: entry.source,
    provenance: entry.provenance,
    persistable: entry.persistable,
    selectable: entry.selectable,
    expandsTo: entry.expandsTo ?? [],
  }));
  return crypto.createHash('sha256').update(JSON.stringify(authorityShape)).digest('hex');
}

function categoryForTool(tool: LocalToolEntry): string {
  if (['read_file', 'list_dir', 'grep_search', 'glob_files', 'write_file', 'edit_file', 'apply_patch', 'notebook_edit', 'lsp'].includes(tool.name)) return 'files-code';
  if (['run_command', 'task_output', 'wait_until', 'kill_command', 'computer_use'].includes(tool.name)) return 'terminal-computer';
  if (['fetch_url', 'web_search', 'research_note', 'research_brief'].includes(tool.name)) return 'web-research';
  if (tool.name.includes('mcp')) return 'mcp-connectors';
  if (tool.name.includes('agent') || tool.name.includes('worker') || tool.name.includes('workflow') || tool.name === 'route_task') return 'orchestration-workflows';
  if (tool.name.includes('vulnerability') || tool.name.includes('scan') || tool.name.includes('request') || tool.name.includes('sitemap') || tool.name === 'scope_rules') return 'security-review';
  if (tool.name.includes('plan') || tool.name.includes('goal') || tool.name.includes('track') || tool.name === 'mark_chapter') return 'planning-session';
  if (tool.name.includes('connector')) return 'mcp-connectors';
  if (tool.name.includes('artifact')) return 'notes-artifacts';
  return 'runtime-control';
}

function availabilityReason(tool: LocalToolEntry): string {
  if (tool.availability) return `Unavailable until ${tool.availability} is active.`;
  if (tool.runtimePort) return `Unavailable without the ${tool.runtimePort} runtime.`;
  return 'Unavailable in the current runtime.';
}
