/**
 * CHAT-BROWSER-ISOLATION — pure ownership helpers for the Desktop browser.
 *
 * Chromium cookies and storage remain workspace-scoped so sign-ins survive a
 * new chat. Agent tab authority is narrower: a chat may observe and drive only
 * tabs it opened. Keeping this logic pure makes the cross-session boundary
 * testable without Electron.
 */
import type { BrowserControlCommand } from '@kinqs/brainrouter-core/browser';
import type { BrowserState } from './protocol.js';

export function scopedBrowserState(state: BrowserState, ownedTabIds: ReadonlySet<string>): BrowserState {
  const tabs = state.tabs.filter((tab) => ownedTabIds.has(tab.id));
  const activeTabId = ownedTabIds.has(state.activeTabId)
    ? state.activeTabId
    : (tabs.at(-1)?.id ?? '');
  const owned = new Set(tabs.map((tab) => tab.id));
  return {
    ...state,
    activeTabId,
    tabs,
    downloads: state.downloads.filter((download) => download.tabId !== null && owned.has(download.tabId)),
    permissionPrompt: state.permissionPrompt && owned.has(state.permissionPrompt.tabId)
      ? state.permissionPrompt
      : null,
    dialogPrompt: state.dialogPrompt && owned.has(state.dialogPrompt.tabId)
      ? state.dialogPrompt
      : null,
  };
}

export function browserCommandTabId(command: BrowserControlCommand): string | undefined {
  return typeof (command as { tabId?: unknown }).tabId === 'string'
    ? (command as { tabId: string }).tabId
    : undefined;
}

export function commandRequiresOwnedTab(command: BrowserControlCommand): boolean {
  return command.kind !== 'capabilities'
    && command.kind !== 'tabs.list'
    && command.kind !== 'tabs.open'
    && command.kind !== 'tabs.reopen';
}

export function scopedBrowserTarget(
  command: BrowserControlCommand,
  state: BrowserState,
  ownedTabIds: ReadonlySet<string>,
): string | undefined {
  const explicit = browserCommandTabId(command);
  if (explicit) return ownedTabIds.has(explicit) ? explicit : undefined;
  if (command.kind === 'permission.respond') {
    return state.permissionPrompt && ownedTabIds.has(state.permissionPrompt.tabId)
      ? state.permissionPrompt.tabId
      : undefined;
  }
  if (command.kind === 'dialog.respond') {
    return state.dialogPrompt && ownedTabIds.has(state.dialogPrompt.tabId)
      ? state.dialogPrompt.tabId
      : undefined;
  }
  if (command.kind === 'download.action') {
    const tabId = state.downloads.find((row) => row.id === command.downloadId)?.tabId;
    return tabId && ownedTabIds.has(tabId) ? tabId : undefined;
  }
  if (!commandRequiresOwnedTab(command)) return undefined;
  if (ownedTabIds.has(state.activeTabId)) return state.activeTabId;
  for (let index = state.tabs.length - 1; index >= 0; index -= 1) {
    const tab = state.tabs[index];
    if (tab && ownedTabIds.has(tab.id)) return tab.id;
  }
  return undefined;
}
