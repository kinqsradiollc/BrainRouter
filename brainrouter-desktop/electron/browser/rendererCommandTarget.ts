import type { BrowserCommand, BrowserState, BrowserTabId } from './protocol.js';

type RendererTargetState = Pick<
  BrowserState,
  'activeTabId' | 'dialogPrompt' | 'downloads' | 'permissionPrompt'
>;

/**
 * Bind an implicit renderer command to the tab the user was looking at when IPC
 * accepted it. The returned id is carried through queue waits so a later tab or
 * workspace switch cannot retarget the command implicitly.
 */
export function concreteRendererBrowserTarget(
  command: BrowserCommand,
  state: RendererTargetState,
): BrowserTabId | undefined {
  switch (command.op) {
    case 'state':
    case 'create-tab':
    case 'reopen-tab':
      return undefined;
    case 'select-tab':
    case 'reorder-tab':
      return command.tabId;
    case 'close-tab':
      return command.tabId ?? state.activeTabId;
    case 'respond-permission':
      return state.permissionPrompt?.id === command.promptId
        ? state.permissionPrompt.tabId
        : state.activeTabId;
    case 'respond-dialog':
      return state.dialogPrompt?.id === command.promptId
        ? state.dialogPrompt.tabId
        : state.activeTabId;
    case 'open-download':
    case 'show-download':
    case 'cancel-download':
    case 'pause-download':
    case 'resume-download':
      return state.downloads.find((download) => download.id === command.downloadId)?.tabId
        ?? state.activeTabId;
    default:
      return state.activeTabId;
  }
}
