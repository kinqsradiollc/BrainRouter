import { type Step } from '../../wizard/types.js';
import type { ThemeMode } from '../../theme/theme.js';

export const TOTAL_STEPS = 5;

export function progressBadge(step: Step): string | undefined {
  const decisionSteps: Step[] = ['theme', 'provider', 'apiKey', 'model', 'mcp'];
  const idx = decisionSteps.indexOf(step);
  if (idx < 0) return undefined;
  return `Step ${idx + 1} of ${TOTAL_STEPS}`;
}

export const ACCENT: Record<ThemeMode, string> = {
  dark: '#8B7CFF',
  light: '#5D49C7',
  mono: 'white',
};
