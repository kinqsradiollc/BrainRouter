/**
 * P23-16 — profile-aware view recommendations. This catalog only changes
 * discovery order; it never hides a compatible panel or grants its tools.
 */
import { MANUAL_PANEL_DEFS, type PanelId } from '../../panels/panelCatalog.js';

export interface WorkspaceViewContext {
  profileId: string;
  capabilityIds: readonly string[];
}

const PROFILE_VIEWS: Readonly<Record<string, readonly PanelId[]>> = {
  // ADR-028 G5 — `stack` (Pull request) carries what `review` and `ci` used to.
  // Those two ids stayed in this list after the panels were consolidated, so
  // two of engineering's seven suggestions matched no panel and silently
  // dropped out of the menu.
  engineering: ['files', 'diff', 'plan', 'tasks', 'artifacts', 'stack'],
  research: ['knowledge', 'memory', 'context', 'plan', 'tasks', 'artifacts', 'annotations'],
  'data-science': ['files', 'knowledge', 'context', 'plan', 'tasks', 'artifacts'],
  study: ['knowledge', 'memory', 'context', 'plan', 'tasks', 'artifacts'],
  writing: ['knowledge', 'memory', 'context', 'plan', 'artifacts', 'annotations'],
  custom: ['context'],
};

const CAPABILITY_VIEWS: Readonly<Record<string, readonly PanelId[]>> = {
  frontend: ['browser', 'prototype', 'servers'],
  backend: ['servers'],
};

export interface GroupedWorkspaceViews {
  active: typeof MANUAL_PANEL_DEFS;
  suggested: typeof MANUAL_PANEL_DEFS;
  more: typeof MANUAL_PANEL_DEFS;
}

/** Keep every installed view discoverable while ordering useful defaults first. */
export function groupWorkspaceViews(
  context: WorkspaceViewContext,
  open: readonly PanelId[],
): GroupedWorkspaceViews {
  const activeIds = new Set(open);
  const suggestedIds = new Set<PanelId>(PROFILE_VIEWS[context.profileId] ?? PROFILE_VIEWS.custom);
  for (const capabilityId of context.capabilityIds) {
    for (const panelId of CAPABILITY_VIEWS[capabilityId] ?? []) suggestedIds.add(panelId);
  }
  const active = MANUAL_PANEL_DEFS.filter((panel) => activeIds.has(panel.id));
  const suggested = MANUAL_PANEL_DEFS.filter((panel) => !activeIds.has(panel.id) && suggestedIds.has(panel.id));
  const more = MANUAL_PANEL_DEFS.filter((panel) => !activeIds.has(panel.id) && !suggestedIds.has(panel.id));
  return { active, suggested, more };
}

/** Safely derive presentation metadata from the untrusted bridge record. */
export function workspaceViewContextFromManifest(manifest: Record<string, unknown> | null | undefined): WorkspaceViewContext {
  const profileId = typeof manifest?.profile === 'string' ? manifest.profile : 'custom';
  const capabilities = manifest?.capabilities;
  const enabled = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
    ? (capabilities as Record<string, unknown>).enabled
    : undefined;
  return {
    profileId,
    capabilityIds: Array.isArray(enabled)
      ? enabled.filter((value): value is string => typeof value === 'string')
      : [],
  };
}
