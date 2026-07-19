/**
 * Per-workspace UI-map session. It intentionally has no production browser
 * launcher: the live embedded browser port is injected per Agent invocation and
 * cannot safely live in a process-global workspace singleton. The legacy
 * CommandLayer remains for manifest-flow compatibility and fails deterministically
 * until a caller explicitly replaces its backend (tests only).
 *
 * The manifest is the panel's in-memory copy when it has extracted this run, else
 * the last `ui-map.json` on disk — so the agent sees whatever the panel built.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CommandLayer } from './command/commands.js';
import { UnavailableBackend, type Backend } from './command/backend.js';
import { UiMapSchema } from './schema.js';
import type { UiMap, Device, UiCommandResult } from './types.js';

export interface UiTestSession {
  readonly workspaceRoot: string;
  baseUrl: string;
  /** The active manifest — in-memory (panel extract) or read from disk. */
  manifest(): UiMap | null;
  /** Set the in-memory manifest (the panel calls this after extraction). */
  setManifest(m: UiMap | null): void;
  readonly layer: CommandLayer;
  readonly backend: Backend;
  /** @deprecated Test-only alias retained for compatibility. */
  readonly driver: Backend;
  setDevice(device: Device): Promise<UiCommandResult>;
  close(): Promise<void>;
}

const sessions = new Map<string, UiTestSession>();

/** Where the panel writes / the agent reads the generated manifest. */
export function manifestPathFor(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'ui-tests', 'ui-map.json');
}

export function readManifestFromDisk(workspaceRoot: string): UiMap | null {
  try {
    return UiMapSchema.parse(JSON.parse(fs.readFileSync(manifestPathFor(workspaceRoot), 'utf8')));
  } catch {
    return null;
  }
}

/** Get (or lazily create) the shared session for a workspace. */
export function getUiTestSession(workspaceRoot: string): UiTestSession {
  const existing = sessions.get(workspaceRoot);
  if (existing) return existing;

  let baseUrl = '';
  let mem: UiMap | null = null;
  const backend: Backend = new UnavailableBackend();

  const session: UiTestSession = {
    workspaceRoot,
    get baseUrl() {
      return baseUrl;
    },
    set baseUrl(v: string) {
      baseUrl = String(v ?? '').trim();
    },
    manifest: () => mem ?? readManifestFromDisk(workspaceRoot),
    setManifest: (m) => {
      mem = m;
    },
    layer: new CommandLayer(backend, () => session.manifest() ?? undefined, () => baseUrl),
    backend,
    driver: backend,
    setDevice: (device) => session.layer.setDevice(device),
    close: async () => {
      sessions.delete(workspaceRoot);
      await backend.close?.();
    },
  };
  sessions.set(workspaceRoot, session);
  return session;
}

/** Test seam: drop all cached sessions. */
export function __resetUiTestSessionsForTests(): void {
  for (const s of sessions.values()) void s.backend.close?.();
  sessions.clear();
}
