/**
 * Workspace-scoped browser download lifecycle manager.
 *
 * It owns agent gesture leases, download rows, item controls, listener
 * rotation, and event projection. Privileged Electron session/shell access is
 * supplied through the host port.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrowserManagerError } from './browserManagerError.js';
import {
  boundBrowserText,
  type BrowserDownload,
  type BrowserEvent,
  type BrowserTab,
  type BrowserTabId,
} from './protocol.js';

export interface BrowserDownloadItem {
  getFilename(): string;
  getURL(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  setSavePath(path: string): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  on(event: 'updated', listener: (_event: unknown, state: string) => void): void;
  once(event: 'done', listener: (_event: unknown, state: string) => void): void;
}

export interface BrowserDownloadHost {
  listen(
    partition: string,
    listener: (
      event: { preventDefault(): void },
      item: BrowserDownloadItem,
      contentsId: number,
    ) => void,
  ): () => void;
  prepareSavePath(filename: string): string;
  showItemInFolder(path: string): void;
  openPath(path: string): Promise<string>;
}

export interface BrowserDownloadManagerCallbacks {
  tabForContents(contentsId: number): BrowserTab | null;
  isAgentControlled(tabId: BrowserTabId): boolean;
  emit(event: BrowserEvent): void;
  emitState(): void;
}

type DownloadCommand =
  | 'open-download'
  | 'show-download'
  | 'cancel-download'
  | 'pause-download'
  | 'resume-download';

export function safeDownloadName(name: string): string {
  const base = path.basename(name)
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  return boundBrowserText(base || 'download', 180);
}

export function availableDownloadPath(
  directory: string,
  filename: string,
): string {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let candidate = path.join(directory, filename);
  for (
    let sequence = 1;
    fs.existsSync(candidate) && sequence < 10_000;
    sequence += 1
  ) {
    candidate = path.join(directory, `${stem} (${sequence})${extension}`);
  }
  return candidate;
}

export class BrowserDownloadManager {
  private readonly downloads: BrowserDownload[] = [];
  private readonly downloadItems = new Map<string, BrowserDownloadItem>();
  private readonly downloadWorkspaces = new Map<string, string>();
  private readonly agentAllowances = new Map<BrowserTabId, number>();
  private sequence = 0;
  private detachDownloadListener: (() => void) | null = null;

  constructor(
    private readonly host: BrowserDownloadHost,
    private readonly callbacks: BrowserDownloadManagerCallbacks,
    private readonly windowPrefix: string,
    private workspaceRoot: string,
    private partition: string,
  ) {
    this.installListener();
  }

  setWorkspace(workspaceRoot: string, partition: string): void {
    this.detachListener();
    this.workspaceRoot = workspaceRoot;
    this.partition = partition;
    this.installListener();
  }

  list(): BrowserDownload[] {
    return this.downloads
      .filter((download) =>
        this.downloadWorkspaces.get(download.id) === this.workspaceRoot,
      )
      .map((download) => ({ ...download }));
  }

  allowAgentInteraction(tabId: BrowserTabId, expiresAt: number): void {
    this.agentAllowances.set(tabId, expiresAt);
  }

  transferAgentAllowance(fromTabId: BrowserTabId, toTabId: BrowserTabId): void {
    const allowance = this.agentAllowances.get(fromTabId);
    if (!allowance || allowance < Date.now()) return;
    this.agentAllowances.delete(fromTabId);
    this.agentAllowances.set(toTabId, allowance);
  }

  releaseTab(tabId: BrowserTabId): void {
    this.agentAllowances.delete(tabId);
  }

  async execute(command: DownloadCommand, id: string): Promise<{ ok: true }> {
    const download = this.downloads.find((entry) => entry.id === id);
    if (
      !download
      || this.downloadWorkspaces.get(id) !== this.workspaceRoot
    ) {
      throw new BrowserManagerError(
        'INVALID_REQUEST',
        'Download was not found in the active workspace.',
      );
    }
    if (command === 'cancel-download') {
      this.downloadItems.get(id)?.cancel();
      return { ok: true };
    }
    if (command === 'pause-download') {
      this.downloadItems.get(id)?.pause();
      return { ok: true };
    }
    if (command === 'resume-download') {
      this.downloadItems.get(id)?.resume();
      return { ok: true };
    }
    if (!download.savePath) {
      throw new BrowserManagerError(
        'NOT_READY',
        'Download has no saved file yet.',
      );
    }
    if (command === 'show-download') {
      this.host.showItemInFolder(download.savePath);
    } else {
      const error = await this.host.openPath(download.savePath);
      if (error) throw new BrowserManagerError('INTERNAL', error);
    }
    return { ok: true };
  }

  dispose(): void {
    this.detachListener();
    this.downloadItems.clear();
    this.downloadWorkspaces.clear();
    this.agentAllowances.clear();
  }

  private installListener(): void {
    if (this.detachDownloadListener) return;
    const listener: Parameters<BrowserDownloadHost['listen']>[1] = (
      event,
      item,
      contentsId,
    ) => {
      const tab = this.callbacks.tabForContents(contentsId);
      if (!tab) return;
      const id = `download_${this.windowPrefix}_${++this.sequence}`;
      const filename = safeDownloadName(item.getFilename());
      const agentControlled = this.callbacks.isAgentControlled(tab.id);
      const gestureExpires = this.agentAllowances.get(tab.id) ?? 0;
      if (agentControlled && gestureExpires < Date.now()) {
        event.preventDefault();
        item.cancel();
        const blocked: BrowserDownload = {
          id,
          tabId: tab.id,
          filename,
          url: boundBrowserText(item.getURL(), 8_192),
          savePath: null,
          receivedBytes: 0,
          totalBytes: item.getTotalBytes(),
          state: 'cancelled',
          startedAt: Date.now(),
        };
        this.downloads.push(blocked);
        this.downloadWorkspaces.set(id, this.workspaceRoot);
        this.trim();
        this.emitDownload(blocked);
        return;
      }
      if (agentControlled) this.agentAllowances.delete(tab.id);

      const savePath = this.host.prepareSavePath(filename);
      item.setSavePath(savePath);
      const row: BrowserDownload = {
        id,
        tabId: tab.id,
        filename,
        url: boundBrowserText(item.getURL(), 8_192),
        savePath,
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        state: 'progressing',
        startedAt: Date.now(),
      };
      this.downloads.push(row);
      this.downloadWorkspaces.set(id, this.workspaceRoot);
      this.trim();
      this.downloadItems.set(id, item);
      this.emitDownload(row);
      item.on('updated', (_event, state) => {
        row.receivedBytes = item.getReceivedBytes();
        row.totalBytes = item.getTotalBytes();
        row.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        this.emitDownload(row);
      });
      item.once('done', (_event, state) => {
        row.receivedBytes = item.getReceivedBytes();
        row.totalBytes = item.getTotalBytes();
        row.state = state === 'completed'
          ? 'completed'
          : state === 'cancelled'
            ? 'cancelled'
            : 'interrupted';
        this.downloadItems.delete(id);
        this.emitDownload(row);
      });
    };
    this.detachDownloadListener = this.host.listen(this.partition, listener);
  }

  private detachListener(): void {
    this.detachDownloadListener?.();
    this.detachDownloadListener = null;
  }

  private trim(): void {
    if (this.downloads.length <= 100) return;
    const removed = this.downloads.splice(0, this.downloads.length - 100);
    for (const stale of removed) {
      this.downloadItems.delete(stale.id);
      this.downloadWorkspaces.delete(stale.id);
    }
  }

  private emitDownload(download: BrowserDownload): void {
    if (this.downloadWorkspaces.get(download.id) === this.workspaceRoot) {
      this.callbacks.emit({
        type: 'download',
        download: { ...download },
      });
    }
    this.callbacks.emitState();
  }
}
