/**
 * MAS-P5-T4 (0.4.2) — per-workspace pack enable/disable state.
 *
 * Packs are **opt-in**: a pack's agents only join the registry once it's
 * explicitly enabled in this workspace (keeps the base agent roster clean
 * and predictable — no surprise agents from a discovered pack). State
 * persists at `<workspace>/.brainrouter/packs.json`.
 *
 * The pure predicate `isPackEnabled(enabled, name)` is exported so the
 * registry + commands can be tested without touching disk.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface PackState {
  /** Pack names the user has explicitly enabled in this workspace. */
  enabled: string[];
}

function packStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'packs.json');
}

export function readPackState(workspaceRoot: string): PackState {
  try {
    const raw = fs.readFileSync(packStatePath(workspaceRoot), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PackState>;
    const enabled = Array.isArray(parsed.enabled)
      ? parsed.enabled.filter((x): x is string => typeof x === 'string')
      : [];
    return { enabled };
  } catch {
    return { enabled: [] };
  }
}

function writePackState(workspaceRoot: string, state: PackState): void {
  const file = packStatePath(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Dedupe + sort for a stable, diff-friendly file.
  const enabled = Array.from(new Set(state.enabled)).sort();
  fs.writeFileSync(file, JSON.stringify({ enabled }, null, 2) + '\n', 'utf-8');
}

/** Pure: a pack is active only when it's in the enabled list. */
export function isPackEnabled(enabled: string[], name: string): boolean {
  return enabled.includes(name);
}

export function enablePack(workspaceRoot: string, name: string): void {
  const state = readPackState(workspaceRoot);
  if (state.enabled.includes(name)) return; // already enabled
  writePackState(workspaceRoot, { enabled: [...state.enabled, name] });
}

export function disablePack(workspaceRoot: string, name: string): void {
  const state = readPackState(workspaceRoot);
  if (!state.enabled.includes(name)) return; // already disabled
  writePackState(workspaceRoot, { enabled: state.enabled.filter((n) => n !== name) });
}
