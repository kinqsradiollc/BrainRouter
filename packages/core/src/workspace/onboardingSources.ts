/**
 * One host-owned snapshot for onboarding catalog and orchestration-plan sources.
 *
 * Plugin discovery runs once so catalog choices and plan reference validation
 * cannot disagree about which inert skill/profile contributions are enabled.
 * Returned data contains only safe catalog metadata and bounded diagnostics.
 */
import type { Config } from '../config/configTypes.js';
import { bundledOrchestrationProfileReferences } from '../orchestration/profiles/orchestrationProfileCatalog.js';
import {
  resolveOrchestrationProfileSources,
  type ResolvedOrchestrationProfileCatalog,
} from '../orchestration/profiles/orchestrationProfileSources.js';
import { loadPlugins } from '../plugin/loader.js';
import {
  buildWorkspaceSelectionCatalog,
  type ContributedWorkspaceSkillRoot,
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
  const catalog = buildWorkspaceSelectionCatalog({ contributedSkillRoots });
  const enabledPluginSkillIds = catalog.entries
    .filter((entry) => entry.kind === 'skill' && entry.source === 'plugin' && entry.selectable)
    .map((entry) => entry.id);
  const references = bundledOrchestrationProfileReferences({
    additionalSkillIds: enabledPluginSkillIds,
  });
  const orchestrationProfiles = resolveOrchestrationProfileSources({
    workspaceRoot,
    pluginContributions: plugins.contributions,
    references,
  });
  return { catalog, orchestrationProfiles };
}
