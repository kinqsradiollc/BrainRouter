/**
 * SYSTEM TRAY — pure menu model (§5.8).
 *
 * The electron-free half of the tray: shorten a workspace path for display and
 * build the tray menu MODEL (labels + typed action descriptors). `tray.ts` maps
 * this model onto an electron `Menu` with live click handlers — keeping the
 * structure here makes it unit-testable without the electron runtime.
 */

export type TrayAction =
  | { kind: 'toggle-window' }
  | { kind: 'open-workspace'; root: string }
  | { kind: 'quit' };

export interface TrayMenuItem {
  label?: string;
  type?: 'normal' | 'separator';
  enabled?: boolean;
  action?: TrayAction;
  submenu?: TrayMenuItem[];
}

/** A compact recents label: the last `maxSegments` path segments, e.g. `…/parent/leaf`. */
export function shortenPath(root: string, maxSegments = 2): string {
  const parts = root.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= maxSegments) return root;
  return `…/${parts.slice(-maxSegments).join('/')}`;
}

export interface TrayMenuOptions {
  windowVisible: boolean;
  /** Recent workspace roots, most-recent first. */
  recents: string[];
  recentsCap?: number;
}

/** Build the tray context-menu model: show/hide, a Recent-workspaces submenu, and quit. */
export function buildTrayMenuModel(opts: TrayMenuOptions): TrayMenuItem[] {
  const cap = opts.recentsCap ?? 8;
  const recentItems: TrayMenuItem[] = opts.recents.length
    ? opts.recents.slice(0, cap).map((root) => ({ label: shortenPath(root), action: { kind: 'open-workspace', root } as TrayAction }))
    : [{ label: 'No recent workspaces', enabled: false }];
  return [
    { label: opts.windowVisible ? 'Hide BrainRouter' : 'Show BrainRouter', action: { kind: 'toggle-window' } },
    { type: 'separator' },
    { label: 'Recent workspaces', submenu: recentItems },
    { type: 'separator' },
    { label: 'Quit BrainRouter', action: { kind: 'quit' } },
  ];
}
