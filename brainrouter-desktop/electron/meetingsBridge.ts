/**
 * Meetings host bridge (ADR-018). The renderer never holds the account bearer
 * (spec §7.3), so meeting reads/writes are proxied here in the main process to the
 * account backend's /api/meetings. Registered once from main.ts.
 */
import { ipcMain } from 'electron';
import { loadConfig } from '@kinqs/brainrouter-core/config';
import { resolveBrainRouterAccountApi } from './accountIntegration.js';

interface FetchLike { ok: boolean; status: number; json(): Promise<unknown> }

/** Authenticated call to the account backend. Null when signed out / unsafe URL. */
async function accountFetch(path: string, init?: { method?: string; body?: string }): Promise<FetchLike | null> {
  const api = resolveBrainRouterAccountApi(loadConfig());
  if (!api?.baseUrl || !api.apiKey) return null;
  const base = api.baseUrl.replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(base); } catch { return null; }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  // The account bearer must never travel in cleartext to a non-loopback host (CWE-319).
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Bearer ${api.apiKey}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(init?.body ? { body: init.body } : {}),
    redirect: 'error',
  });
  return res as unknown as FetchLike;
}

function id(v: unknown): string { return encodeURIComponent(String(v ?? '')); }

export function registerMeetingsBridge(): void {
  ipcMain.handle('meetings:list', async () => {
    const r = await accountFetch('/api/meetings');
    if (!r?.ok) return [];
    const data = (await r.json()) as { meetings?: unknown };
    return Array.isArray(data.meetings) ? data.meetings : [];
  });

  ipcMain.handle('meetings:get', async (_e, meetingId: unknown) => {
    const r = await accountFetch(`/api/meetings/${id(meetingId)}`);
    return r?.ok ? await r.json() : null;
  });

  ipcMain.handle('meetings:create', async (_e, input: unknown) => {
    const body = JSON.stringify(input ?? {});
    const r = await accountFetch('/api/meetings', { method: 'POST', body });
    if (!r) throw new Error('Sign in to BrainRouter to save meetings.');
    if (!r.ok) throw new Error('Could not create the meeting.');
    return await r.json();
  });

  ipcMain.handle('meetings:setScope', async (_e, meetingId: unknown, scope: unknown, opts: unknown) => {
    const teamId = opts && typeof opts === 'object' ? (opts as { teamId?: string }).teamId : undefined;
    const r = await accountFetch(`/api/meetings/${id(meetingId)}/scope`, { method: 'POST', body: JSON.stringify({ scope, teamId }) });
    if (!r?.ok) throw new Error('Could not change sharing.');
    return await r.json();
  });

  // Secondary interactions — persisted server-side in a later slice (task #8 tail).
  // They resolve optimistically so the UI stays responsive; the core list/detail/
  // create/scope/public flow above is fully backend-backed.
  ipcMain.handle('meetings:regenerate', async () => { /* re-summarize route: pending */ });
  ipcMain.handle('meetings:toggleAction', async () => { /* action-item persistence: pending */ });
  ipcMain.handle('meetings:actionToTrack', async (_e, _meetingId: unknown, actionId: unknown) => ({ trackItemId: `pending-${String(actionId)}` }));
}
