/**
 * SYSTEM TRAY (§5.8) — the electron half.
 *
 * Creates the menu-bar / system-tray icon and a dynamic context menu (show/hide
 * the window, a live "Recent workspaces" submenu, quit). The menu STRUCTURE comes
 * from the pure {@link ./trayMenu} model (unit-tested); this file only maps it to
 * an electron `Menu` with click handlers and rebuilds it on each open so recents
 * + visibility stay fresh. The icon is an embedded 16×16 template PNG, so there's
 * no binary asset to ship — macOS recolours it to match the menu bar.
 */
import { Tray, Menu, nativeImage } from 'electron';
import { buildTrayMenuModel } from './trayMenu.js';
/** 16×16 template glyph (a small node ring + center dot), black + alpha. */
const TRAY_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAkElEQVR4nLWT3Q2AIAyEv+GYxQd24MkJnIA5dAx2YAsTjcmZIMH4U73kXtq70haAn+AADwTRK3YLm2ECMjCLWbFwZR4kTkAEejEqlqU5PXkTjEDXyHfK5VYnTi2mE3NZJEl72IlX5VgZFrFElNbX7c+atzbXRXppw6cFzCOYl4j1GneYHlLZyeunvMP0mR5hBVrSTS0nQli4AAAAAElFTkSuQmCC';
function dispatch(action, host) {
    if (!action)
        return;
    switch (action.kind) {
        case 'toggle-window':
            host.toggleWindow();
            break;
        case 'open-workspace':
            host.openWorkspace(action.root);
            break;
        case 'quit':
            host.quit();
            break;
    }
}
function toTemplate(items, host) {
    return items.map((it) => {
        if (it.type === 'separator')
            return { type: 'separator' };
        return {
            label: it.label,
            enabled: it.enabled,
            ...(it.submenu ? { submenu: toTemplate(it.submenu, host) } : {}),
            ...(it.action ? { click: () => dispatch(it.action, host) } : {}),
        };
    });
}
/**
 * Create the tray. Returns the {@link Tray} (held by the caller so it isn't GC'd)
 * or null if the platform/environment can't host one — the app stays fully usable
 * either way.
 */
export function setupTray(host) {
    try {
        const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`);
        icon.setTemplateImage(true);
        const tray = new Tray(icon);
        tray.setToolTip('BrainRouter');
        const refresh = () => {
            const model = buildTrayMenuModel({ windowVisible: host.isWindowVisible(), recents: host.recents() });
            tray.setContextMenu(Menu.buildFromTemplate(toTemplate(model, host)));
        };
        refresh();
        // Rebuild on each interaction so recents + the show/hide label stay live.
        tray.on('click', refresh);
        tray.on('right-click', refresh);
        return tray;
    }
    catch {
        return null;
    }
}
