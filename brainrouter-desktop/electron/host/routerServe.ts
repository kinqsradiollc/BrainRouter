import { getCliKnobs, loadConfig } from '@kinqs/brainrouter-core/config';
import { startRouterGateway } from '@kinqs/brainrouter-core/router/gateway';

export interface RouterServeStatus {
  running: boolean;
  host: string | null;
  port: number | null;
  startedAt: string | null;
  url: string | null;
  recentEvents: string[];
  lastError: string | null;
}

interface RouterServeState {
  handle: Awaited<ReturnType<typeof startRouterGateway>> | null;
  startedAt: string | null;
  recent: string[];
  lastError: string | null;
}

const state: RouterServeState = { handle: null, startedAt: null, recent: [], lastError: null };
const RECENT_CAP = 20;

function note(line: string): void {
  state.recent.unshift(`${new Date().toISOString()} ${line}`);
  if (state.recent.length > RECENT_CAP) state.recent.length = RECENT_CAP;
}

export function routerServeStatus(): RouterServeStatus {
  const url = state.handle ? `http://${state.handle.host}:${state.handle.port}/router/v1` : null;
  return {
    running: !!state.handle,
    host: state.handle?.host ?? null,
    port: state.handle?.port ?? null,
    startedAt: state.startedAt,
    url,
    recentEvents: [...state.recent],
    lastError: state.lastError,
  };
}

export async function startRouterServe(): Promise<{ ok: boolean; error?: string; host?: string; port?: number }> {
  if (state.handle) return { ok: true, host: state.handle.host, port: state.handle.port };
  const knobs = getCliKnobs().router;
  if (knobs.serve !== true) {
    return { ok: false, error: 'Router gateway is disabled — turn on cli.router.serve first.' };
  }
  if (!knobs.serveKey) {
    return { ok: false, error: 'Router gateway requires cli.router.serveKey.' };
  }
  try {
    state.handle = await startRouterGateway({
      config: loadConfig(),
      host: knobs.serveHost,
      port: knobs.servePort,
      serveKey: knobs.serveKey,
    });
    state.startedAt = new Date().toISOString();
    state.lastError = null;
    note(`listening on http://${state.handle.host}:${state.handle.port}/router/v1`);
    return { ok: true, host: state.handle.host, port: state.handle.port };
  } catch (err) {
    state.handle = null;
    state.startedAt = null;
    state.lastError = err instanceof Error ? err.message : String(err);
    return { ok: false, error: state.lastError };
  }
}

export async function stopRouterServe(): Promise<{ ok: boolean; error?: string }> {
  const handle = state.handle;
  if (!handle) return { ok: true };
  state.handle = null;
  state.startedAt = null;
  try {
    await handle.close();
    note('stopped');
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastError = msg;
    return { ok: false, error: msg };
  }
}
