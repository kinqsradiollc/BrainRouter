import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
} from 'electron';

const MAX_DISPLAY_ORIGIN_LENGTH = 512;
const MAX_DISPLAY_REALM_LENGTH = 200;
const MAX_USERNAME_LENGTH = 1_024;
const MAX_PASSWORD_LENGTH = 8_192;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

export interface HttpAuthPromptDetails {
  origin: string;
  realm?: string | null;
}

export interface HttpAuthDisplayDetails {
  origin: string;
  realm: string;
}

export interface HttpAuthCredentials {
  username: string;
  password: string;
}

export interface HttpAuthPromptOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

type HttpAuthIpcEvent = { sender: unknown; senderFrame: unknown };
type HttpAuthIpcListener = (event: HttpAuthIpcEvent, payload: unknown) => void;
type PromptEvent = { preventDefault(): void };

export interface HttpAuthPromptWindow {
  readonly webContents: {
    readonly id: number;
    readonly mainFrame: unknown;
    setWindowOpenHandler(handler: () => { action: 'deny' }): void;
    on(event: string, listener: (...args: never[]) => void): unknown;
    removeListener(event: string, listener: (...args: never[]) => void): unknown;
  };
  on(event: string, listener: (...args: never[]) => void): unknown;
  once(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  setMenuBarVisibility(visible: boolean): void;
  setMenu(menu: null): void;
}

export interface HttpAuthPromptRuntime {
  readonly preloadPath: string;
  createPromptId(): string;
  createToken(): string;
  createWindow(options: BrowserWindowConstructorOptions): HttpAuthPromptWindow;
  onIpc(channel: string, listener: HttpAuthIpcListener): void;
  removeIpcListener(channel: string, listener: HttpAuthIpcListener): void;
  scheduleTimeout(handler: () => void, timeoutMs: number): () => void;
}

function boundDisplayText(value: unknown, maxLength: number): string {
  const clean = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(clean).slice(0, maxLength).join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function normalizeHttpAuthDisplayDetails(details: HttpAuthPromptDetails): HttpAuthDisplayDetails {
  let origin = 'this site';
  try {
    const parsed = new URL(boundDisplayText(details.origin, MAX_DISPLAY_ORIGIN_LENGTH));
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin;
  } catch {
    // Fail closed to a generic label rather than displaying an attacker-shaped URL.
  }
  return {
    origin: boundDisplayText(origin, MAX_DISPLAY_ORIGIN_LENGTH) || 'this site',
    realm: boundDisplayText(details.realm, MAX_DISPLAY_REALM_LENGTH),
  };
}

export function buildHttpAuthPromptHtml(details: HttpAuthPromptDetails): string {
  const display = normalizeHttpAuthDisplayDetails(details);
  const origin = escapeHtml(display.origin);
  const realm = escapeHtml(display.realm);
  const realmMarkup = realm ? `<p class="realm">Realm: <span>${realm}</span></p>` : '';
  const csp = escapeHtml(
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; "
      + "connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; "
      + "form-action 'none'; frame-ancestors 'none'",
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authentication required</title>
  <style>
    :root { color-scheme: light dark; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
    h1 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 0 0 18px; color: GrayText; overflow-wrap: anywhere; }
    .realm { margin-top: -10px; font-size: 12px; }
    .realm span { color: CanvasText; }
    label { display: block; margin: 12px 0 5px; font-weight: 600; }
    input { width: 100%; height: 34px; padding: 6px 9px; border: 1px solid GrayText; border-radius: 6px; background: Field; color: FieldText; }
    input:focus { outline: 2px solid Highlight; outline-offset: 1px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
    button { min-width: 78px; height: 32px; border: 1px solid GrayText; border-radius: 6px; padding: 0 14px; }
    button[type="submit"] { border-color: Highlight; background: Highlight; color: HighlightText; }
  </style>
</head>
<body>
  <main>
    <h1>Authentication required</h1>
    <p><strong>${origin}</strong> is requesting a username and password.</p>
    ${realmMarkup}
    <form id="auth-form" autocomplete="on">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" maxlength="1024" autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" maxlength="8192">
      <div class="actions">
        <button id="cancel" type="button">Cancel</button>
        <button type="submit">Sign in</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

function boundedTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(timeoutMs)));
}

function credentialsFromPayload(payload: unknown): HttpAuthCredentials | null {
  if (!payload || typeof payload !== 'object') return null;
  const { username, password } = payload as Record<string, unknown>;
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) return null;
  return { username, password };
}

/** Creates a broker with an injectable Electron boundary for focused testing. */
export function createHttpAuthPromptBroker(runtime: HttpAuthPromptRuntime) {
  return function openHttpAuthPrompt(
    parent: BrowserWindow,
    details: HttpAuthPromptDetails,
    options: HttpAuthPromptOptions = {},
  ): Promise<HttpAuthCredentials | null> {
    if (parent.isDestroyed() || options.signal?.aborted) return Promise.resolve(null);

    const promptId = runtime.createPromptId();
    const channel = `brainrouter:http-auth:${promptId}`;
    const token = runtime.createToken();
    let promptWindow: HttpAuthPromptWindow;
    try {
      promptWindow = runtime.createWindow({
        parent,
        modal: true,
        show: false,
        width: 440,
        height: 420,
        minWidth: 400,
        minHeight: 390,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        title: 'Authentication required',
        backgroundColor: '#171717',
        webPreferences: {
          preload: runtime.preloadPath,
          additionalArguments: [
            `--brainrouter-http-auth-channel=${channel}`,
            `--brainrouter-http-auth-token=${token}`,
          ],
          partition: `brainrouter-http-auth-${promptId}`,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          devTools: false,
          spellcheck: false,
          safeDialogs: true,
        },
      });
    } catch {
      return Promise.resolve(null);
    }

    promptWindow.setMenuBarVisibility(false);
    promptWindow.setMenu(null);
    promptWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    return new Promise<HttpAuthCredentials | null>((resolve) => {
      let settled = false;
      let cancelTimeout = (): void => {};
      const denyNavigation = (event: PromptEvent): void => event.preventDefault();
      const showPrompt = (): void => {
        if (settled || promptWindow.isDestroyed()) return;
        promptWindow.show();
        promptWindow.focus();
      };

      const cleanup = (): void => {
        cancelTimeout();
        runtime.removeIpcListener(channel, onIpc);
        options.signal?.removeEventListener('abort', onAbort);
        parent.removeListener('closed', onParentClosed);
        promptWindow.removeListener('closed', onPromptClosed);
        promptWindow.removeListener('unresponsive', onUnresponsive);
        promptWindow.removeListener('ready-to-show', showPrompt);
        promptWindow.webContents.removeListener('render-process-gone', onRenderProcessGone);
        promptWindow.webContents.removeListener('will-navigate', denyNavigation);
        promptWindow.webContents.removeListener('will-redirect', denyNavigation);
        promptWindow.webContents.removeListener('will-attach-webview', denyNavigation);
      };
      const settle = (credentials: HttpAuthCredentials | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!promptWindow.isDestroyed()) promptWindow.close();
        resolve(credentials);
      };
      const onAbort = (): void => settle(null);
      const onParentClosed = (): void => settle(null);
      const onPromptClosed = (): void => settle(null);
      const onUnresponsive = (): void => settle(null);
      const onRenderProcessGone = (): void => settle(null);
      const onIpc: HttpAuthIpcListener = (event, payload): void => {
        if (event.sender !== promptWindow.webContents) return;
        if (event.senderFrame !== promptWindow.webContents.mainFrame) return;
        if (!payload || typeof payload !== 'object') return;
        const record = payload as Record<string, unknown>;
        if (record.token !== token) return;
        if (record.action === 'cancel') {
          settle(null);
          return;
        }
        if (record.action !== 'submit') return;
        const credentials = credentialsFromPayload(record);
        if (credentials) settle(credentials);
      };

      runtime.onIpc(channel, onIpc);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      parent.once('closed', onParentClosed);
      promptWindow.once('closed', onPromptClosed);
      promptWindow.once('unresponsive', onUnresponsive);
      promptWindow.once('ready-to-show', showPrompt);
      promptWindow.webContents.on('render-process-gone', onRenderProcessGone);
      promptWindow.webContents.on('will-navigate', denyNavigation);
      promptWindow.webContents.on('will-redirect', denyNavigation);
      promptWindow.webContents.on('will-attach-webview', denyNavigation);
      cancelTimeout = runtime.scheduleTimeout(() => settle(null), boundedTimeout(options.timeoutMs));

      if (parent.isDestroyed() || options.signal?.aborted) {
        settle(null);
        return;
      }
      const htmlUrl = `data:text/html;charset=UTF-8,${encodeURIComponent(buildHttpAuthPromptHtml(details))}`;
      void promptWindow.loadURL(htmlUrl).then(showPrompt, () => settle(null));
    });
  };
}

const preloadPath = join(dirname(fileURLToPath(import.meta.url)), 'httpAuthPromptPreload.cjs');

/**
 * Opens a one-shot main-owned modal. Credentials return only to Electron main;
 * they are never sent through the application's renderer or browser protocol.
 */
export async function promptForHttpAuth(
  parent: BrowserWindow,
  details: HttpAuthPromptDetails,
  options: HttpAuthPromptOptions = {},
): Promise<HttpAuthCredentials | null> {
  try {
    const { BrowserWindow: ElectronBrowserWindow, ipcMain } = await import('electron');
    const runtime: HttpAuthPromptRuntime = {
      preloadPath,
      createPromptId: randomUUID,
      createToken: () => randomBytes(32).toString('hex'),
      createWindow: (windowOptions) => new ElectronBrowserWindow(windowOptions) as unknown as HttpAuthPromptWindow,
      onIpc: (channel, listener) => ipcMain.on(channel, listener as Parameters<typeof ipcMain.on>[1]),
      removeIpcListener: (channel, listener) => ipcMain.removeListener(channel, listener as Parameters<typeof ipcMain.removeListener>[1]),
      scheduleTimeout(handler, timeoutMs) {
        const timer = setTimeout(handler, timeoutMs);
        return () => clearTimeout(timer);
      },
    };
    return await createHttpAuthPromptBroker(runtime)(parent, details, options);
  } catch {
    return null;
  }
}
