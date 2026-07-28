import type {
  EffortLevel,
  ExecutionMode,
  PersonalityResolution,
  PersonalityStyle,
  ReviewPolicy,
  ResolvedMode,
  SessionMode,
} from '@kinqs/brainrouter-core/session';

export type DesktopSessionModePatch = Partial<SessionMode>;

const EXECUTION_MODES = new Set<ExecutionMode>(['planning', 'fast']);
const REVIEW_POLICIES = new Set<ReviewPolicy>(['request', 'proceed']);
const EFFORT_LEVELS = new Set<EffortLevel>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PERSONALITY_STYLES = new Set<PersonalityStyle>(['concise', 'standard', 'detailed', 'pair-programmer']);

export function desktopSessionModePatchFromArgs(args: Record<string, unknown>): { patch: DesktopSessionModePatch; error?: string } {
  const patch: DesktopSessionModePatch = {};
  if ('executionMode' in args) {
    const value = args.executionMode;
    if (value != null && value !== '' && !EXECUTION_MODES.has(value as ExecutionMode)) {
      return { patch: {}, error: `Unknown execution mode "${String(value)}".` };
    }
    patch.executionMode = value as ExecutionMode | undefined;
  }
  if ('reviewPolicy' in args) {
    const value = args.reviewPolicy;
    if (value != null && value !== '' && !REVIEW_POLICIES.has(value as ReviewPolicy)) {
      return { patch: {}, error: `Unknown review policy "${String(value)}".` };
    }
    patch.reviewPolicy = value as ReviewPolicy | undefined;
  }
  if ('effort' in args) {
    const value = args.effort;
    if (value != null && value !== '' && !EFFORT_LEVELS.has(value as EffortLevel)) {
      return { patch: {}, error: `Unknown effort "${String(value)}".` };
    }
    patch.effort = value as EffortLevel | undefined;
  }
  if ('personality' in args) {
    const value = args.personality;
    if (value != null && value !== '' && !PERSONALITY_STYLES.has(value as PersonalityStyle)) {
      return { patch: {}, error: `Unknown personality "${String(value)}".` };
    }
    patch.personality = value as PersonalityStyle | undefined;
  }
  return { patch };
}

export function mergeSessionModePrefs(
  workspacePrefs: Record<string, unknown>,
  activeMode: ResolvedMode,
  activePersonality: PersonalityResolution,
): Record<string, unknown> {
  return {
    ...workspacePrefs,
    executionMode: activeMode.executionMode,
    reviewPolicy: activeMode.reviewPolicy,
    effort: activeMode.effort,
    personality: activePersonality.style,
    personalitySource: activePersonality.source,
  };
}
