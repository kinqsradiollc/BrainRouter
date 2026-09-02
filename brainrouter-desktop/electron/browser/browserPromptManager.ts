/**
 * Browser permission and page-dialog lifecycle manager.
 *
 * Prompt state, remembered grants, timeouts, cancellation, and event ordering
 * live here. The BrowserViewManager facade supplies tab lookup and presentation
 * callbacks without granting this service access to Electron views.
 */
import type {
  BrowserCommand,
  BrowserEvent,
  BrowserState,
  BrowserTab,
  BrowserTabId,
} from './protocol.js';
import { boundBrowserText } from './protocol.js';
import { BrowserManagerError } from './browserManagerError.js';
import type { PersistedPermissionDecision } from './browserWorkspaceStore.js';
import { isPersistableBrowserPermission, browserPermissionGrantsFor } from './browserPermissionPolicy.js';

type DialogResponse = { accept: boolean; value?: string };

type PendingPermission = {
  id: string;
  tabId: BrowserTabId;
  respond: (allow: boolean) => void;
  cancel: () => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingDialog = {
  id: string;
  tabId: BrowserTabId;
  finish: (response: DialogResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface BrowserPromptManagerHost {
  tabForContents(contentsId: number): BrowserTab | null;
  selectTab(tabId: BrowserTabId): void;
  persist(): void;
  emit(event: BrowserEvent): void;
  emitState(): void;
  setStatus(tab: BrowserTab, text: string): void;
}

export interface BrowserPromptManagerOptions {
  permissionTimeoutMs?: number;
  dialogTimeoutMs?: number;
}

export class BrowserPromptManager {
  private permissionSequence = 0;
  private dialogSequence = 0;
  private permissionPrompt: BrowserState['permissionPrompt'] = null;
  private dialogPrompt: BrowserState['dialogPrompt'] = null;
  private pendingPermission: PendingPermission | null = null;
  private pendingDialog: PendingDialog | null = null;
  private readonly permissionGrants = new Set<string>();
  private readonly permissionDecisions =
    new Map<string, PersistedPermissionDecision['decision']>();
  private readonly permissionTimeoutMs: number;
  private readonly dialogTimeoutMs: number;

  constructor(
    private readonly host: BrowserPromptManagerHost,
    private readonly windowPrefix: string,
    options: BrowserPromptManagerOptions = {},
  ) {
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 30_000;
    this.dialogTimeoutMs = options.dialogTimeoutMs ?? 60_000;
  }

  getPermissionPrompt(): BrowserState['permissionPrompt'] {
    return this.permissionPrompt ? { ...this.permissionPrompt } : null;
  }

  getDialogPrompt(): BrowserState['dialogPrompt'] {
    return this.dialogPrompt ? { ...this.dialogPrompt } : null;
  }

  hasPermission(rawOrigin: string, grants: string[]): boolean {
    if (grants.length === 0) return false;
    let origin = rawOrigin;
    try {
      origin = new URL(rawOrigin).origin;
    } catch {
      // Invalid origins cannot acquire grants.
    }
    return grants.every((permission) =>
      this.permissionGrants.has(`${origin}\n${permission}`),
    );
  }

  requestPermission(
    contentsId: number,
    permission: string,
    grants: string[],
    rawOrigin: string,
    callback: (allow: boolean) => void,
  ): void {
    const tab = this.host.tabForContents(contentsId);
    if (!tab || grants.length === 0) {
      callback(false);
      return;
    }
    let origin = '';
    try {
      origin = new URL(rawOrigin || tab.url).origin;
    } catch {
      origin = rawOrigin || tab.url;
    }
    const decisionKey = `${origin}\n${permission}`;
    const saved = isPersistableBrowserPermission(permission)
      ? this.permissionDecisions.get(decisionKey)
      : undefined;
    if (saved) {
      callback(saved === 'allow');
      return;
    }
    if (this.hasPermission(origin, grants)) {
      callback(true);
      return;
    }
    this.cancelPermission();

    const id = `permission_${++this.permissionSequence}`;
    const finish = (allow: boolean, remember: boolean): void => {
      if (allow) {
        for (const grant of grants) {
          this.permissionGrants.add(`${origin}\n${grant}`);
        }
      }
      if (remember && isPersistableBrowserPermission(permission)) {
        this.permissionDecisions.set(
          decisionKey,
          allow ? 'allow' : 'block',
        );
        this.host.persist();
      }
      callback(allow);
      if (this.pendingPermission?.id === id) this.pendingPermission = null;
      this.permissionPrompt = null;
      this.host.emit({ type: 'permission', prompt: null });
      this.host.emitState();
    };
    const timer = setTimeout(
      () => finish(false, false),
      this.permissionTimeoutMs,
    );
    this.pendingPermission = {
      id,
      tabId: tab.id,
      respond: (allow) => finish(allow, true),
      cancel: () => finish(false, false),
      timer,
    };
    this.permissionPrompt = {
      id,
      tabId: tab.id,
      origin: boundBrowserText(origin, 512),
      permission: boundBrowserText(permission, 128),
    };
    this.host.selectTab(tab.id);
    this.host.emit({ type: 'permission', prompt: this.permissionPrompt });
    this.host.emitState();
  }

  respondPermission(id: string, allow: boolean): { ok: true } {
    if (!this.pendingPermission || this.pendingPermission.id !== id) {
      throw new BrowserManagerError(
        'INVALID_REQUEST',
        'Permission prompt is no longer active.',
      );
    }
    const pending = this.pendingPermission;
    this.pendingPermission = null;
    clearTimeout(pending.timer);
    pending.respond(allow);
    return { ok: true };
  }

  presentDialog(
    tab: BrowserTab,
    prompt: Omit<NonNullable<BrowserState['dialogPrompt']>, 'id' | 'tabId'>,
    responder: (response: DialogResponse) => void,
  ): void {
    this.cancelDialog();
    const id = `dialog_${this.windowPrefix}_${++this.dialogSequence}`;
    let settled = false;
    let timer!: ReturnType<typeof setTimeout>;
    const finish = (response: DialogResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (this.pendingDialog?.id === id) this.pendingDialog = null;
      if (this.dialogPrompt?.id === id) {
        this.dialogPrompt = null;
        this.host.emit({ type: 'dialog', prompt: null });
        this.host.emitState();
      }
      try {
        responder(response);
      } catch (error) {
        this.host.setStatus(
          tab,
          `Could not answer browser prompt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    timer = setTimeout(
      () => finish({ accept: false }),
      this.dialogTimeoutMs,
    );
    this.pendingDialog = { id, tabId: tab.id, finish, timer };
    this.dialogPrompt = { id, tabId: tab.id, ...prompt };
    this.host.selectTab(tab.id);
    this.host.emit({ type: 'dialog', prompt: { ...this.dialogPrompt } });
    this.host.emitState();
  }

  respondDialog(
    command: Extract<BrowserCommand, { op: 'respond-dialog' }>,
  ): { ok: true } {
    const pending = this.pendingDialog;
    if (!pending || pending.id !== command.promptId) {
      throw new BrowserManagerError(
        'INVALID_REQUEST',
        'Browser prompt is no longer active.',
      );
    }
    pending.finish({
      accept: command.accept,
      value: boundBrowserText(command.value, 4_096),
    });
    return { ok: true };
  }

  cancelForTab(tabId: BrowserTabId): void {
    this.cancelDialog(tabId);
    if (this.pendingPermission?.tabId === tabId) this.cancelPermission();
  }

  stopForTab(tabId: BrowserTabId): void {
    this.cancelDialog(tabId);
    if (this.pendingPermission?.tabId === tabId) {
      this.respondPermission(this.pendingPermission.id, false);
    }
  }

  clearPermissions(): void {
    this.permissionGrants.clear();
    this.permissionDecisions.clear();
  }

  restorePermissions(decisions: PersistedPermissionDecision[]): void {
    for (const row of decisions.slice(0, 200)) {
      if (
        !row?.permission
        || !isPersistableBrowserPermission(row.permission)
        || (row.decision !== 'allow' && row.decision !== 'block')
      ) {
        continue;
      }
      let origin = '';
      try {
        const parsed = new URL(row.origin);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          continue;
        }
        origin = parsed.origin;
      } catch {
        continue;
      }
      this.permissionDecisions.set(`${origin}\n${row.permission}`, row.decision);
      if (row.decision === 'allow') {
        // Re-add the grants Chromium actually checks (camera -> media:video).
        for (const grant of browserPermissionGrantsFor(row.permission)) {
          this.permissionGrants.add(`${origin}\n${grant}`);
        }
      }
    }
  }

  persistedPermissions(): PersistedPermissionDecision[] {
    return [...this.permissionDecisions.entries()]
      .slice(-200)
      .map(([key, decision]) => ({
        origin: key.slice(0, key.lastIndexOf('\n')),
        permission: key.slice(key.lastIndexOf('\n') + 1),
        decision,
      }));
  }

  dispose(): void {
    this.cancelPermission();
    this.cancelDialog();
  }

  private cancelPermission(): void {
    const pending = this.pendingPermission;
    if (!pending) return;
    this.pendingPermission = null;
    clearTimeout(pending.timer);
    pending.cancel();
  }

  private cancelDialog(tabId?: BrowserTabId): void {
    const pending = this.pendingDialog;
    if (!pending || (tabId && pending.tabId !== tabId)) return;
    pending.finish({ accept: false });
  }
}
