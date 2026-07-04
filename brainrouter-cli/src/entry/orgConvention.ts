import type { Config } from '@kinqs/brainrouter-core/config';
import { resolveCliKnobs } from '@kinqs/brainrouter-core/config';
import {
  createGhCliOrgConventionProvider,
  refreshOrgConventionRepoRoots,
} from '@kinqs/brainrouter-core/plugin';

export async function refreshCliOrgConventionRepos(config: Config): Promise<void> {
  const knobs = resolveCliKnobs(config);
  if (!knobs.skills.orgRepoDiscovery || knobs.safeMode) return;
  try {
    await refreshOrgConventionRepoRoots({
      enabled: true,
      providers: [createGhCliOrgConventionProvider()],
    });
  } catch {
    // Org repositories are additive and optional; startup must continue offline.
  }
}
