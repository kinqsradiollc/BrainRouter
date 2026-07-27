import type { WorkspaceProfileId } from '../../workspace/profiles.js';

export type PersonalityStyle = 'concise' | 'standard' | 'detailed' | 'pair-programmer';
export type PersonalityMode = 'auto' | 'manual';
export type PersonalitySource = 'chat' | 'workspace' | 'global' | 'profile' | 'fallback';

export interface PersonalityResolution {
  style: PersonalityStyle;
  source: PersonalitySource;
}

export interface ResolvePersonalityInput {
  profile?: WorkspaceProfileId;
  chatOverride?: PersonalityStyle;
  workspaceOverride?: PersonalityStyle;
  globalDefault?: PersonalityStyle;
}

const PROFILE_RECOMMENDATIONS: Partial<Record<WorkspaceProfileId, PersonalityStyle>> = {
  engineering: 'pair-programmer',
  research: 'detailed',
  'data-science': 'detailed',
  study: 'standard',
  writing: 'standard',
};

/** Profiles recommend presentation only; this never grants behavior or authority. */
export function profilePersonalityRecommendation(
  profile: WorkspaceProfileId | undefined,
): PersonalityStyle | undefined {
  return profile ? PROFILE_RECOMMENDATIONS[profile] : undefined;
}

/**
 * Resolve communication style independently from persona, capabilities,
 * skills, tools, and orchestration.
 */
export function resolvePersonality(input: ResolvePersonalityInput): PersonalityResolution {
  if (input.chatOverride) return { style: input.chatOverride, source: 'chat' };
  if (input.workspaceOverride) return { style: input.workspaceOverride, source: 'workspace' };
  if (input.globalDefault) return { style: input.globalDefault, source: 'global' };
  const recommended = profilePersonalityRecommendation(input.profile);
  if (recommended) return { style: recommended, source: 'profile' };
  return { style: 'standard', source: 'fallback' };
}
