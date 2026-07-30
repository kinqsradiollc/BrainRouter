/**
 * D26-9 — packaged browser bridge self-test.
 *
 * The signed-build verifier launches the real packaged application with an
 * isolated profile. Once the renderer preload has loaded, this module asks the
 * shipped bridge to create two tabs and report browser state, then writes one
 * bounded result file for the parent verifier. No debugging port is exposed.
 */
import fs from 'node:fs';
import { resolvePackagedSmokeConfig } from './packagedSmokeBootstrap.js';

interface PackagedSmokeApp {
  readonly isPackaged: boolean;
  quit(): void;
}

interface PackagedSmokeWindow {
  isDestroyed(): boolean;
  readonly webContents: {
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
    isLoading(): boolean;
    once(event: 'did-finish-load', listener: () => void): unknown;
  };
}

interface PackagedSmokeResult {
  ok: boolean;
  smoke?: unknown;
  error?: string;
}

const PACKAGED_SMOKE_TIMEOUT_MS = 30_000;

const PACKAGED_BROWSER_EXPRESSION = `(async () => {
  const bridge = globalThis.brainrouter;
  const api = bridge && bridge.browser;
  if (!api || typeof api.getState !== 'function' || typeof api.command !== 'function'
      || typeof bridge.send !== 'function' || typeof bridge.onEvent !== 'function'
      || typeof bridge.workspaceManifest !== 'function') {
    return { bridge: false };
  }
  const queryId = 'packaged-smoke-session-info';
  const host = await new Promise((resolve) => {
    let off = () => {};
    const finish = (value) => {
      clearTimeout(timer);
      off();
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: 'utility host query timed out' }),
      20000,
    );
    off = bridge.onEvent((message) => {
      const event = message && message.event ? message.event : message;
      if (!event || event.kind !== 'query-result' || event.id !== queryId) return;
      finish(event);
    });
    bridge.send({ kind: 'query', id: queryId, name: 'session-info' });
  });
  const workspaceRoot = host && host.ok && host.result && host.result.workspaceRoot;
  const manifest = typeof workspaceRoot === 'string'
    ? await bridge.workspaceManifest(workspaceRoot)
    : null;
  const initial = await api.getState();
  const first = await api.command({ op: 'create-tab', url: 'about:blank', active: true });
  const second = await api.command({ op: 'create-tab', url: 'about:blank', active: true });
  const command = await api.command({ op: 'state' });
  const finalState = await api.getState();
  return {
    bridge: true,
    hostOk: host && host.ok === true,
    manifestOk: manifest && manifest.ok === true,
    initialCount: Array.isArray(initial && initial.tabs) ? initial.tabs.length : -1,
    finalCount: Array.isArray(finalState && finalState.tabs) ? finalState.tabs.length : -1,
    firstOk: first && first.ok === true,
    secondOk: second && second.ok === true,
    commandOk: command && command.ok === true,
    firstId: first && first.value && first.value.id,
    secondId: second && second.value && second.value.id,
    nativeTabs: finalState && finalState.capabilities && finalState.capabilities.nativeTabs === true,
    sameVisibleTabAutomation: finalState && finalState.capabilities && finalState.capabilities.sameVisibleTabAutomation === true,
    userAgent: navigator.userAgent,
  };
})()`;

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function writeResult(resultPath: string, result: PackagedSmokeResult): void {
  const temporary = `${resultPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, resultPath);
}

async function waitForRenderer(window: PackagedSmokeWindow): Promise<void> {
  if (!window.webContents.isLoading()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('packaged renderer did not finish loading')), PACKAGED_SMOKE_TIMEOUT_MS);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('packaged browser bridge self-test timed out')), PACKAGED_SMOKE_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runPackagedBrowserSmokeIfRequested(
  app: PackagedSmokeApp,
  window: PackagedSmokeWindow,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!app.isPackaged) return false;
  const config = resolvePackagedSmokeConfig(env);
  if (!config) return false;

  let result: PackagedSmokeResult;
  try {
    if (window.isDestroyed()) throw new Error('packaged browser smoke window was destroyed');
    await waitForRenderer(window);
    if (window.isDestroyed()) throw new Error('packaged browser smoke window was destroyed');
    result = {
      ok: true,
      smoke: await withTimeout(window.webContents.executeJavaScript(PACKAGED_BROWSER_EXPRESSION, true)),
    };
  } catch (error) {
    result = { ok: false, error: boundedError(error) };
  }

  try {
    writeResult(config.result, result);
  } catch (error) {
    process.stderr.write(`Packaged browser smoke could not write its result: ${boundedError(error)}\n`);
  } finally {
    app.quit();
  }
  return true;
}
