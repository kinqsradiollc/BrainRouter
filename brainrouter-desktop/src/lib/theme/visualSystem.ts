export const VISUAL_SYSTEM_STORAGE_KEY = 'desktop.visualSystemV2';

export type DesktopVisualSystem = 'legacy' | 'v2';

export function visualSystemEnabled(storedValue: unknown): boolean {
  return storedValue === true || storedValue === 'true' || storedValue === '1';
}

export function visualSystemDataValue(enabled: boolean): DesktopVisualSystem {
  return enabled ? 'v2' : 'legacy';
}

export function applyVisualSystemToDocument(enabled: boolean): void {
  document.documentElement.dataset.visualSystem = visualSystemDataValue(enabled);
}
