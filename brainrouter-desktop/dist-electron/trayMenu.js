/**
 * SYSTEM TRAY — pure menu model (§5.8).
 *
 * The electron-free half of the tray: shorten a workspace path for display and
 * build the tray menu MODEL (labels + typed action descriptors). `tray.ts` maps
 * this model onto an electron `Menu` with live click handlers — keeping the
 * structure here makes it unit-testable without the electron runtime.
 */
/** A compact recents label: the last `maxSegments` path segments, e.g. `…/parent/leaf`. */
export function shortenPath(root, maxSegments = 2) {
    const parts = root.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= maxSegments)
        return root;
    return `…/${parts.slice(-maxSegments).join('/')}`;
}
/** Build the tray context-menu model: show/hide, a Recent-workspaces submenu, and quit. */
export function buildTrayMenuModel(opts) {
    const cap = opts.recentsCap ?? 8;
    const recentItems = opts.recents.length
        ? opts.recents.slice(0, cap).map((root) => ({ label: shortenPath(root), action: { kind: 'open-workspace', root } }))
        : [{ label: 'No recent workspaces', enabled: false }];
    return [
        { label: opts.windowVisible ? 'Hide BrainRouter' : 'Show BrainRouter', action: { kind: 'toggle-window' } },
        { type: 'separator' },
        { label: 'Recent workspaces', submenu: recentItems },
        { type: 'separator' },
        { label: 'Quit BrainRouter', action: { kind: 'quit' } },
    ];
}
