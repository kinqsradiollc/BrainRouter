/**
 * The shared per-workspace UI-testing session — the one process-level singleton
 * that makes "one browser, two consumers" true. The Desktop panel (via the host)
 * and the agent (via the built-in extension) both call `getUiTestSession(root)`
 * and get the SAME headed Playwright driver, the SAME dev-server base URL, and a
 * `CommandLayer` over the SAME manifest. Keyed by workspace root; cached for the
 * life of the process.
 *
 * The manifest is the panel's in-memory copy when it has extracted this run, else
 * the last `ui-map.json` on disk — so the agent sees whatever the panel built.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DriverClient } from './driver/driverClient.js';
import { CommandLayer } from './command/commands.js';
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
  readonly driver: DriverClient;
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
  // The driver is constructed lazily-launched (it only spawns on first command).
  const driver = new DriverClient({ cwd: workspaceRoot, headed: true, timeoutMs: 30000 });

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
    layer: new CommandLayer(driver, () => session.manifest() ?? undefined, () => baseUrl),
    driver,
    setDevice: (device) => session.layer.setDevice(device),
    close: async () => {
      sessions.delete(workspaceRoot);
      await driver.close();
    },
  };
  sessions.set(workspaceRoot, session);
  return session;
}

/** Test seam: drop all cached sessions. */
export function __resetUiTestSessionsForTests(): void {
  for (const s of sessions.values()) void s.driver.close();
  sessions.clear();
}
