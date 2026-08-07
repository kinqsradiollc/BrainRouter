/**
 * A stable per-install device id, shared by every offline-first surface.
 *
 * Part of every HLC stamp and the final tie-break that makes ordering total, so
 * it must not drift: a device that silently changes its id looks like a NEW
 * peer to the merge rules, and its own past edits become concurrent with its
 * present ones. Read from the cache when present, derived deterministically
 * otherwise, and persisted on first write.
 *
 * Keyed by the cache file rather than by the machine, so each surface's id is
 * derived from the file it will be stamped into. That means one install can
 * hold a different id for the planner than for notes, which is harmless — the
 * id only ever breaks ties within a single clock domain — and it is the safe
 * choice, because unifying them would change the id of every planner cache
 * already on disk, which is the exact drift this exists to prevent.
 */
import { readJsonFile } from '../storage/store.js';

export function stableDeviceId(cacheFile: string): string {
  const stored = readJsonFile<{ deviceId?: string }>(cacheFile, {});
  if (stored.deviceId) return stored.deviceId;
  let hash = 0;
  const seed = `${cacheFile}:${process.platform}`;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return `d${Math.abs(hash).toString(36)}`;
}
