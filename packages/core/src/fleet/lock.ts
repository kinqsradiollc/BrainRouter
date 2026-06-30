/**
 * HONK-H3 — single-runner host lock.
 *
 * The durable queue is intentionally drained by ONE runner per host (two runners
 * on the same `~/.brainrouter` would race the whole-file read-modify-write — see
 * fleetStore's docstring). This file is that interlock: a runner acquires the lock
 * before draining and heartbeats while alive; a second would-be runner backs off.
 *
 * "Owned" means: the lock file names a DIFFERENT pid that is BOTH still alive AND
 * has heartbeat within the TTL. A lock whose owner died, or whose heartbeat went
 * stale (process wedged / SIGKILLed without releasing), is reclaimable — so a host
 * crash never permanently wedges the fleet. All decisions are injectable
 * (`isAlive`/`now`) so this unit-tests without spawning processes.
 */
import path from 'node:path';
import { hostname } from 'node:os';
import { existsSync, rmSync } from 'node:fs';
import { getBrainrouterHome, readJsonFile, writeJsonFile } from '../storage/store.js';

export interface FleetLockRecord {
  pid: number;
  host: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface FleetLockHandle {
  readonly record: FleetLockRecord;
  /** Refresh the heartbeat (call on the runner's tick). No-op if we lost the lock. */
  heartbeat(now?: Date): boolean;
  /** Release the lock iff we still own it. */
  release(): void;
}

/** A held heartbeat older than this marks the lock reclaimable even if the pid
 *  still resolves (the owner is wedged, not draining). */
export const FLEET_LOCK_TTL_MS = 30_000;

function lockFile(home?: string): string {
  return path.join(home ?? getBrainrouterHome(), 'fleet', 'runner.lock');
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM = process exists but we may not signal it (still alive); ESRCH = gone.
    return (err as { code?: string })?.code === 'EPERM';
  }
}

interface AcquireOpts {
  home?: string;
  pid?: number;
  now?: Date;
  ttlMs?: number;
  isAlive?: (pid: number) => boolean;
}

/** Returns true when `existing` represents a live lock owned by a DIFFERENT pid. */
function ownedByOther(existing: FleetLockRecord | null, pid: number, now: Date, ttlMs: number, isAlive: (pid: number) => boolean): boolean {
  if (!existing || existing.pid === pid) return false;
  const fresh = now.getTime() - new Date(existing.heartbeatAt).getTime() < ttlMs;
  return fresh && isAlive(existing.pid);
}

/**
 * Try to acquire the host runner lock. Returns a handle, or `null` when another
 * live runner already holds it. Reclaims a stale/dead lock. Re-acquiring as the
 * same pid refreshes in place (keeps the original `acquiredAt`).
 */
export function acquireFleetLock(opts?: AcquireOpts): FleetLockHandle | null {
  const home = opts?.home;
  const pid = opts?.pid ?? process.pid;
  const now = opts?.now ?? new Date();
  const ttlMs = opts?.ttlMs ?? FLEET_LOCK_TTL_MS;
  const isAlive = opts?.isAlive ?? defaultIsAlive;
  const file = lockFile(home);

  const existing = readJsonFile<FleetLockRecord | null>(file, null);
  if (ownedByOther(existing, pid, now, ttlMs, isAlive)) return null;

  const record: FleetLockRecord = {
    pid,
    host: hostname(),
    acquiredAt: existing?.pid === pid ? existing.acquiredAt : now.toISOString(),
    heartbeatAt: now.toISOString(),
  };
  writeJsonFile(file, record);

  return {
    record,
    heartbeat(at?: Date): boolean {
      const current = readJsonFile<FleetLockRecord | null>(file, null);
      if (!current || current.pid !== pid) return false; // lost the lock (reclaimed)
      const beat: FleetLockRecord = { ...current, heartbeatAt: (at ?? new Date()).toISOString() };
      writeJsonFile(file, beat);
      return true;
    },
    release(): void {
      const current = readJsonFile<FleetLockRecord | null>(file, null);
      if (current && current.pid === pid && existsSync(file)) rmSync(file, { force: true });
    },
  };
}

/** Read the current lock holder without acquiring (for status surfaces). */
export function readFleetLock(home?: string): FleetLockRecord | null {
  return readJsonFile<FleetLockRecord | null>(lockFile(home), null);
}
