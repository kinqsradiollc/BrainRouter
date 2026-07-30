export const MODEL_TABS = [
  ['managed', 'Managed'],
  ['personal', 'Personal / BYOK'],
  ['routing', 'Routing'],
  ['profiles', 'Profiles'],
  ['subagents', 'Sub-agents'],
] as const;

export type ModelTab = (typeof MODEL_TABS)[number][0];

export function nextModelTabIndex(index: number, key: string): number | null {
  if (key === 'ArrowRight') return (index + 1) % MODEL_TABS.length;
  if (key === 'ArrowLeft') return (index - 1 + MODEL_TABS.length) % MODEL_TABS.length;
  if (key === 'Home') return 0;
  if (key === 'End') return MODEL_TABS.length - 1;
  return null;
}
