/**
 * One host-owned snapshot for onboarding catalog and orchestration-plan sources.
 *
 * Plugin discovery runs once so catalog choices and plan reference validation
 * cannot disagree about which inert skill/profile contributions are enabled.
 * Returned data contains only safe catalog metadata and bounded diagnostics.
 */
import type { Config } from '../config/configTypes.js';
import {
  loadRegistry,
  type DefinitionSource,
} from '../orchestration/agents/agentRegistry.js';
import {
  bundledOrchestrationProfileReferences,
  orchestrationProfileRoleReference,
} from '../orchestration/profiles/orchestrationProfileCatalog.js';
import {
  resolveOrchestrationProfileSources,
  type ResolvedOrchestrationProfileCatalog,
} from '../orchestration/profiles/orchestrationProfileSources.js';
import { loadPlugins } from '../plugin/loader.js';
import {
  buildWorkspaceSelectionCatalog,
  type ContributedWorkspaceSkillRoot,
  type WorkspaceRoleCatalogDescriptor,
  type WorkspaceSelectionCatalog,
} from './selectionCatalog.js';

export interface WorkspaceOnboardingSources {
  catalog: WorkspaceSelectionCatalog;
  orchestrationProfiles: ResolvedOrchestrationProfileCatalog;
}

/**
 * Resolve onboarding sources from host-owned workspace/config state.
 * Disabled plugin skills remain visible but blocked; only enabled plugin skills
 * may satisfy an orchestration-profile reference.
 */
export function buildWorkspaceOnboardingSources(
  workspaceRoot: string,
  config?: Config,
): WorkspaceOnboardingSources {
  const plugins = loadPlugins(workspaceRoot, config);
  const contributedSkillRoots: ContributedWorkspaceSkillRoot[] = [
    ...plugins.loaded.flatMap((plugin) => plugin.contributes.skills
      ? [{
          pluginName: plugin.name,
          path: plugin.contributes.skills,
          selectable: true,
        }]
      : []),
    ...plugins.disabled.flatMap((plugin) => plugin.contributes.skills
      ? [{
          pluginName: plugin.name,
          path: plugin.contributes.skills,
          selectable: false,
          blockedReason: 'Plugin is installed but disabled.',
        }]
      : []),
  ];
  const loadedRoles = loadRegistry(workspaceRoot);
  const roles = loadedRoles.map((loaded): WorkspaceRoleCatalogDescriptor => ({
    id: loaded.def.id,
    label: loaded.def.displayName,
    description: loaded.def.whenToUse,
    source: roleSource(loaded.source),
    provenance: roleProvenance(loaded.source),
  }));
  const catalog = buildWorkspaceSelectionCatalog({ contributedSkillRoots, roles });
  const enabledPluginSkillIds = catalog.entries
    .filter((entry) => entry.kind === 'skill' && entry.source === 'plugin' && entry.selectable)
    .map((entry) => entry.id);
  const references = bundledOrchestrationProfileReferences({
    additionalSkillIds: enabledPluginSkillIds,
    additionalRoles: loadedRoles.flatMap((loaded) => {
      try {
        return [[
          loaded.def.id,
          orchestrationProfileRoleReference(loaded.def),
        ] as const];
      } catch {
        // 0.4.17 — keep the role visible, but do not let a plan reference it
        // until its output-contract metadata passes the strict plan boundary.
        return [];
      }
    }),
  });
  const orchestrationProfiles = resolveOrchestrationProfileSources({
    workspaceRoot,
    pluginContributions: plugins.contributions,
    references,
  });
  return { catalog, orchestrationProfiles };
}

function roleSource(
  source: DefinitionSource,
): WorkspaceRoleCatalogDescriptor['source'] {
  if (source === 'builtin') return 'bundled';
  return source;
}

function roleProvenance(source: DefinitionSource): string {
  if (source === 'builtin') return 'bundled-roles';
  if (source === 'pack') return 'enabled-pack';
  if (source === 'user') return 'user-config';
  return 'workspace-local';
}
