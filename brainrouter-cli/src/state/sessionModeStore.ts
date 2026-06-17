import { getCliStateFile, readJsonFile, writeJsonFile } from './cliState.js';
import {
  readPreferences,
  resolveEffort,
  type EffortLevel,
  type ExecutionMode,
  type ReviewPolicy,
} from './preferencesStore.js';

/**
 * Per-session execution stance: which `executionMode` / `reviewPolicy` /
 * `effort` a SPECIFIC chat uses. Without this layer, two chats in the same
 * workspace SHARE the workspace-level `preferences.json`, so switching
 * sessions does not restore that session's mode. This store adds a SESSION
 * override layer that wins over workspace prefs — each chat keeps (and
 * restores) its own stance.
 *
 * Resolution is layered: session overrides win over the workspace
 * preferences. A session with no override inherits the workspace value
 * cleanly (we prune empty fields on write so a reverted session leaves no
 * entry). Persisted per workspace in `sessionMode.json`, keyed by sessionKey
 * — the same shape and file convention as `sessionRuntimeStore`.
 *
 * Mirrors the type names from `preferencesStore` so the read sites can keep
 * speaking in `ExecutionMode` / `ReviewPolicy` / `EffortLevel`.
 */
export interface SessionMode {
  executionMode?: ExecutionMode;
  reviewPolicy?: ReviewPolicy;
  effort?: EffortLevel;
}

/** Fully-resolved stance for a session — every field concrete. */
export interface ResolvedMode {
  executionMode: ExecutionMode;
  reviewPolicy: ReviewPolicy;
  effort: EffortLevel;
}

type Store = Record<string, SessionMode>;

const MODE_FIELDS = ['executionMode', 'reviewPolicy', 'effort'] as const;

function modeFile(workspaceRoot: string): string {
  return getCliStateFile(workspaceRoot, 'sessionMode.json');
}

export function readSessionModeAll(workspaceRoot: string): Store {
  return readJsonFile<Store>(modeFile(workspaceRoot), {});
}

export function getSessionMode(workspaceRoot: string, sessionKey: string): SessionMode {
  return readSessionModeAll(workspaceRoot)[sessionKey] ?? {};
}

/**
 * Merge a patch onto a session's override; prune empty fields so a session
 * that reverts to a value (or is cleared) leaves no entry and thus inherits
 * the workspace preference cleanly. Returns the resulting (possibly empty)
 * override for the session.
 */
export function setSessionMode(
  workspaceRoot: string,
  sessionKey: string,
  patch: Partial<SessionMode>,
): SessionMode {
  const all = readSessionModeAll(workspaceRoot);
  const next: SessionMode = { ...(all[sessionKey] ?? {}), ...patch };
  for (const k of MODE_FIELDS) {
    if (next[k] == null || (next[k] as string) === '') delete next[k];
  }
  if (Object.keys(next).length === 0) delete all[sessionKey];
  else all[sessionKey] = next;
  writeJsonFile(modeFile(workspaceRoot), all);
  return all[sessionKey] ?? {};
}

export function clearSessionMode(workspaceRoot: string, sessionKey: string): void {
  const all = readSessionModeAll(workspaceRoot);
  if (all[sessionKey]) {
    delete all[sessionKey];
    writeJsonFile(modeFile(workspaceRoot), all);
  }
}

/**
 * Layered resolution: session overrides > workspace preferences. Pure —
 * given the two layers it returns the concrete stance a session should run
 * with. Dependency-free so the precedence is unit-testable without touching
 * the filesystem.
 *
 * `workspacePrefs` is the already-resolved workspace stance (concrete
 * executionMode/reviewPolicy/effort); `session` is the per-session override.
 */
export function resolveSessionMode(
  workspacePrefs: ResolvedMode,
  session: SessionMode | undefined,
): ResolvedMode {
  const s = session ?? {};
  return {
    executionMode: s.executionMode ?? workspacePrefs.executionMode,
    reviewPolicy: s.reviewPolicy ?? workspacePrefs.reviewPolicy,
    effort: s.effort ?? workspacePrefs.effort,
  };
}

/**
 * Single resolution entry point for the read sites. Reads the workspace
 * preferences (and the layered `resolveEffort`, which honours the
 * `cli.effort` config override) plus the session override, and returns the
 * concrete stance.
 *
 * When `sessionKey` is undefined/empty this returns EXACTLY the workspace
 * stance — there is no session layer to apply, so non-session contexts keep
 * today's behaviour unchanged.
 */
export function resolveActiveMode(workspaceRoot: string, sessionKey?: string): ResolvedMode {
  const prefs = readPreferences(workspaceRoot);
  const workspaceStance: ResolvedMode = {
    executionMode: prefs.executionMode,
    reviewPolicy: prefs.reviewPolicy,
    // `effort` follows the config > preference > default ladder, matching the
    // workspace-only behaviour the read sites had before this layer existed.
    effort: resolveEffort(workspaceRoot).effort,
  };
  if (!sessionKey) return workspaceStance;
  return resolveSessionMode(workspaceStance, getSessionMode(workspaceRoot, sessionKey));
}
