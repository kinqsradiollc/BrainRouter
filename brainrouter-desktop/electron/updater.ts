/**
 * DESK-6 — auto-update scaffold (electron-updater over GitHub Releases).
 *
 * INACTIVE by default — default alpha builds never phone home. Activation
 * requires ALL of:
 *   1. a packaged build  (app.isPackaged), AND
 *   2. BRAINROUTER_UPDATE_CHANNEL set  (e.g. "latest" or "alpha"), AND
 *   3. the optional dependency installed:  npm install electron-updater
 *
 * When active it checks the GitHub release feed (the `publish` block in
 * electron-builder.yml generates the matching latest*.yml during a build) and
 * forwards lifecycle events to the renderer via the supplied `emit` bridge so a
 * future UI can surface "update available / downloading / ready to install".
 *
 * electron-updater is intentionally NOT a declared dependency yet: it would be
 * bundled into every alpha installer and start checking for releases that don't
 * exist. The dynamic import below degrades to a no-op until it's installed, so
 * packaging stays clean and activation is a one-liner (see the desktop README).
 */
import { app } from 'electron';

export type UpdateEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version?: string }
  | { kind: 'none' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version?: string }
  | { kind: 'error'; message: string };

export interface AutoUpdateOptions {
  /** Forward update lifecycle events to the renderer (optional). */
  emit?: (event: UpdateEvent) => void;
}

/**
 * Wire up auto-update iff this is a packaged build with an update channel
 * configured AND electron-updater is installed. Safe to call unconditionally;
 * never throws.
 */
export async function initAutoUpdate(opts: AutoUpdateOptions = {}): Promise<void> {
  const channel = process.env.BRAINROUTER_UPDATE_CHANNEL?.trim();
  if (!app.isPackaged || !channel) {
    return; // dev build or no channel → stay silent, never check for updates
  }

  let autoUpdater: any;
  try {
    // Indirect specifier so the TypeScript compiler does not require
    // electron-updater to be installed at build time (it's install-on-activation).
    const spec = 'electron-updater';
    autoUpdater = (await import(spec)).autoUpdater;
  } catch {
    console.warn(
      '[updater] BRAINROUTER_UPDATE_CHANNEL is set but electron-updater is not installed — ' +
        'run `npm install electron-updater` to enable auto-update.',
    );
    return;
  }

  const emit = opts.emit ?? (() => {});
  try {
    autoUpdater.channel = channel;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => emit({ kind: 'checking' }));
    autoUpdater.on('update-available', (info: any) => emit({ kind: 'available', version: info?.version }));
    autoUpdater.on('update-not-available', () => emit({ kind: 'none' }));
    autoUpdater.on('download-progress', (p: any) => emit({ kind: 'progress', percent: Math.round(p?.percent ?? 0) }));
    autoUpdater.on('update-downloaded', (info: any) => emit({ kind: 'downloaded', version: info?.version }));
    autoUpdater.on('error', (err: any) => emit({ kind: 'error', message: String(err?.message ?? err) }));
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.warn('[updater] auto-update check failed:', err);
  }
}
