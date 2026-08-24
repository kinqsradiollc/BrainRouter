// ADR-041 A41-11 / D11 — layered profile overlays that target composition rows by id.
//
// A host profile (hostProfiles.ts) names, per host, which composition surfaces it
// activates. D11 asks for the next layer: a profile DEFINED as an overlay on a base
// — "a layer targets a row by id and replaces its config; later layers win", and the
// resolved composition records "every row's effective config and which layer set it".
//
// The composition rows here are the six `HostProfileSurfaces` keys (each a stable id:
// agentTools, slashCommands, …). An overlay carries a `Partial<HostProfileSurfaces>`
// — the rows it replaces, keyed by id — layered onto a base host profile. The
// resolver folds an ordered overlay stack onto the base and returns each row with its
// value AND the layer that set it (`base` or `overlay:<id>`), which `dump-composition
// --profile <derived>` renders. The two derived profiles below are the genuine first
// consumers: `minimal` (a headless MCP-only host) and `test` (a tools-only agent).

import {
  HOST_PROFILES,
  resolveHostProfile,
  type HostId,
  type HostProfile,
  type HostProfileSurfaces,
} from './hostProfiles.js';

/** A profile defined as a layer over a base host profile, replacing rows by id. */
export interface ProfileOverlay {
  /** Stable id of the derived profile (e.g. `minimal`). */
  id: string;
  description: string;
  /** The base host profile this layers onto. */
  base: HostId;
  /** The composition rows this overlay replaces, keyed by row id. */
  surfaces: Partial<HostProfileSurfaces>;
}

/** One resolved composition row: its id, effective value, and the layer that set it. */
export interface ResolvedRow {
  id: keyof HostProfileSurfaces;
  value: boolean;
  /** `base` or `overlay:<id>` — which layer determined this row's effective value. */
  layer: string;
}

/** A base host profile with an ordered overlay stack folded onto it. */
export interface ResolvedProfile {
  id: string;
  description: string;
  base: HostId;
  rows: ResolvedRow[];
}

// The fixed row order the resolver and the dump render in — the surface keys, stable.
const SURFACE_ORDER: Array<keyof HostProfileSurfaces> = [
  'agentTools',
  'slashCommands',
  'mcpTools',
  'apiRoutes',
  'panels',
  'providers',
];

/**
 * Fold an ordered overlay stack onto a base host profile. Later overlays win on a
 * row they both touch; an untouched row keeps the base value and the `base` layer.
 */
export function resolveProfileComposition(
  base: HostProfile,
  overlays: ProfileOverlay[],
  derived?: { id: string; description: string },
): ResolvedProfile {
  const value: Record<keyof HostProfileSurfaces, boolean> = { ...base.surfaces };
  const layer: Record<keyof HostProfileSurfaces, string> = {
    agentTools: 'base', slashCommands: 'base', mcpTools: 'base',
    apiRoutes: 'base', panels: 'base', providers: 'base',
  };
  for (const overlay of overlays) {
    for (const key of SURFACE_ORDER) {
      const replacement = overlay.surfaces[key];
      if (replacement !== undefined) {
        value[key] = replacement;
        layer[key] = `overlay:${overlay.id}`;
      }
    }
  }
  return {
    id: derived?.id ?? base.host,
    description: derived?.description ?? base.description,
    base: base.host,
    rows: SURFACE_ORDER.map((key) => ({ id: key, value: value[key], layer: layer[key] })),
  };
}

/**
 * The built-in derived profiles — each a real composition a person would inspect
 * before wiring a deployment, and the genuine consumer that forces the overlay seam.
 */
export const DERIVED_PROFILES = {
  minimal: {
    id: 'minimal',
    base: 'server',
    surfaces: { apiRoutes: false },
    description: 'Headless MCP-only host — the server profile minus the HTTP /api surface.',
  },
  test: {
    id: 'test',
    base: 'cli',
    surfaces: { slashCommands: false },
    description: 'Tools-only programmatic agent — the cli profile minus slash commands.',
  },
} satisfies Record<string, ProfileOverlay>;

/** The derived-profile ids, in a stable order. */
export function derivedProfileIds(): string[] {
  return Object.keys(DERIVED_PROFILES).sort();
}

/** Resolve a derived profile by id against its base, or undefined if unknown. */
export function resolveDerivedProfile(id: string): ResolvedProfile | undefined {
  const overlay = (DERIVED_PROFILES as Record<string, ProfileOverlay>)[id];
  if (!overlay) return undefined;
  const base = resolveHostProfile(overlay.base) ?? HOST_PROFILES[overlay.base];
  return resolveProfileComposition(base, [overlay], { id: overlay.id, description: overlay.description });
}
