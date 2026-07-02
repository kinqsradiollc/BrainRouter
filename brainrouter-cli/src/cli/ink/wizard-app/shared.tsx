import { type Step } from '../../wizard/types.js';
import type { ThemeMode } from '../../theme.js';

export const TOTAL_STEPS = 6;

export function progressBadge(step: Step): string | undefined {
  const decisionSteps: Step[] = ['theme', 'provider', 'apiKey', 'model', 'mcp', 'agentMd'];
  const idx = decisionSteps.indexOf(step);
  if (idx < 0) return undefined;
  return `Step ${idx + 1} of ${TOTAL_STEPS}`;
}

export const ACCENT: Record<ThemeMode, string> = {
  dark: '#CC9166',
  light: '#A24E1F',
  mono: 'white',
};
