/**
 * Account-backed Meetings/Track/Teams Electron bridge.
 *
 * The renderer never holds the account bearer. Every operation is converted to
 * a validated request by meetingsAccountContract, then sent from Electron main
 * to the configured HTTPS (or loopback HTTP) account endpoint.
 */
import { ipcMain } from 'electron';
import { loadConfig } from '@kinqs/brainrouter-core/config';
import { MeetingEndpointUnavailableError } from '@kinqs/brainrouter-core/meetings';
import { brainRouterAccountHeaders, resolveBrainRouterAccountApi, resolveBrainRouterAccountContext, type BrainRouterAccountContext } from './accountIntegration.js';
import { connectMeetingStream, type MeetingStreamConnection } from './meetingStreamConnection.js';
import {
  meetingStreamUrl,
  MeetingStreamUnavailableError,
  MEETING_TRANSCRIPTION_CAPABILITIES_PATH,
} from './meetingStreamProtocol.js';
import type { MeetingStreamPortOpenInput, MeetingTranscriptionStreamPort } from './meetingStreamSession.js';
import { createMeetingStreamSocket } from './meetingStreamSocket.js';
import {
  meetingRequests,
  teamRequests,
  trackRequests,
  type AccountRequest,
  type TrackStatusCategory,
} from './meetingsAccountContract.js';

interface FetchLike { ok: boolean; status: number; json(): Promise<unknown> }

let contextCache: { key: string; value: BrainRouterAccountContext; expiresAt: number } | null = null;

async function defaultAccountContext(config: unknown): Promise<BrainRouterAccountContext | null> {
  const api = resolveBrainRouterAccountApi(config);
  if (!api) return null;
  const key = `${api.baseUrl}\0${api.apiKey}`;
  if (contextCache?.key === key && contextCache.expiresAt > Date.now()) return contextCache.value;
  const value = await resolveBrainRouterAccountContext(config);
  if (value) contextCache = { key, value, expiresAt: Date.now() + 30_000 };
  return value;
}

/** Authenticated call to the account backend. Null when signed out / unsafe URL. */
async function accountFetch(request: AccountRequest): Promise<FetchLike | null> {
  const config = loadConfig();
  const api = resolveBrainRouterAccountApi(config);
  if (!api?.baseUrl || !api.apiKey) return null;
  const base = api.baseUrl.replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(base); } catch { return null; }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  // The account bearer must never travel in cleartext to a non-loopback host.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;

  const body = request.json !== undefined
    ? JSON.stringify(request.json)
    : request.bytes !== undefined ? Buffer.from(request.bytes) : undefined;
  const contentType = request.json !== undefined ? 'application/json' : request.contentType;
  const context = request.path === '/api/orgs'
    ? null
    : request.orgId ? { ...api, orgId: request.orgId } : await defaultAccountContext(config);
  if (request.path !== '/api/orgs' && !context) return null;
  const response = await fetch(`${base}${request.path}`, {
    method: request.method,
    headers: {
      ...(context ? brainRouterAccountHeaders(context) : { Authorization: `Bearer ${api.apiKey}` }),
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    ...(body !== undefined ? { body } : {}),
    redirect: 'error',
  });
  return response as unknown as FetchLike;
}

function apiError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

async function requestJson<T>(request: AccountRequest, fallback: string): Promise<T> {
  const response = await accountFetch(request);
  if (!response) throw new Error('Sign in to BrainRouter to use Meetings, Track, and Teams.');
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) throw new Error(apiError(payload) ?? `${fallback} (${response.status}).`);
  return payload as T;
}

/**
 * ADR-035 D3/D7 — one captured segment against the STT endpoint, for the
 * host-owned transcription queue.
 *
 * It shares `accountFetch` with the IPC handlers deliberately: the bearer, the
 * https-or-loopback rule and the org context are one implementation, and a
 * second HTTP path for meeting audio would be a second place to get any of them
 * wrong.
 *
 * The failure it throws is SHAPED for the shared classifier, because D7 turns on
 * telling two things apart. A status the endpoint declined to serve with travels
 * on `.status`, so 429/503 read as an outage and cost the segment no attempt. A
 * signed-out desktop is also an outage rather than a verdict on the audio: those
 * bytes are fine and will transcribe once someone signs in, and burning four
 * attempts on being logged out would turn a good meeting into permanent gaps.
 */
export async function transcribeCaptureSegment(
  input: { bytes: Uint8Array; contentType: string; language?: string },
): Promise<string> {
  const response = await accountFetch(meetingRequests.transcribe(input));
  if (!response) throw new MeetingEndpointUnavailableError('Sign in to BrainRouter to transcribe this recording.');
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const failure = new Error(apiError(payload) ?? `Could not transcribe this segment (${response.status}).`);
    (failure as Error & { status?: number }).status = response.status;
    throw failure;
  }
  const text = (payload as { text?: unknown } | null)?.text;
  // A segment of silence legitimately transcribes to an empty string, so only a
  // missing/!string field is an error — treating "" as one would turn a quiet
  // twenty seconds into a stated gap.
  if (typeof text !== 'string') throw new Error('The transcription endpoint returned no text for this segment.');
  return text;
}

/**
 * ADR-035 D10 — the endpoint's own answer about which transcription strategy
 * this deployment has.
 *
 * It is a GET on the SAME base and the same bearer as the batch POST, so a host
 * cannot end up asking one endpoint what another one offers. The answer is
 * returned unnormalized: Core's `describeTranscriptionEndpoint` is the single
 * strict reader of that document, and a second, friendlier reader here is how a
 * partial advertisement would get promoted into a live promise nobody can keep.
 *
 * `null` for every failure — signed out, unreachable, 404 on a gateway that
 * predates the route, not JSON. All of them mean the same thing to the caller,
 * which selects the segmented path and says so.
 */
export async function fetchMeetingTranscriptionCapabilities(): Promise<unknown> {
  const response = await accountFetch({ path: MEETING_TRANSCRIPTION_CAPABILITIES_PATH, method: 'GET' })
    .catch(() => null);
  if (!response?.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * ADR-035 D10 — open the persistent transcription connection.
 *
 * This lives beside `accountFetch` for the reason `transcribeCaptureSegment`
 * does: the bearer, the https-or-loopback rule and the org context are ONE
 * implementation. The account key never leaves this module by any other door —
 * the supervisor is handed this function, not the credential.
 *
 * The three refusals below are permanent for the capture that asked, so each
 * carries the sentence the surface will show rather than a generic failure the
 * caller would retry four times before saying anything (golden rule 23).
 */
export async function openMeetingTranscriptionStream(
  input: MeetingStreamPortOpenInput,
): Promise<MeetingStreamConnection> {
  const config = loadConfig();
  const api = resolveBrainRouterAccountApi(config);
  if (!api?.baseUrl || !api.apiKey) {
    throw new MeetingStreamUnavailableError(
      'Live transcription needs a signed-in BrainRouter account, so this meeting is being transcribed in segments. The audio is saved on this device either way.',
    );
  }
  const url = meetingStreamUrl(api.baseUrl);
  if (!url) {
    throw new MeetingStreamUnavailableError(
      'Live transcription needs an https BrainRouter endpoint, so this meeting is being transcribed in segments. The audio is saved on this device either way.',
    );
  }
  const context = await defaultAccountContext(config).catch(() => null);
  if (!context?.orgId) {
    throw new MeetingStreamUnavailableError(
      'Live transcription needs an active BrainRouter organization, so this meeting is being transcribed in segments. The audio is saved on this device either way.',
    );
  }
  return await connectMeetingStream({
    url,
    attach: {
      bearer: api.apiKey,
      requestedOrgId: context.orgId,
      sessionId: input.sessionId,
      mimeType: input.mimeType,
      language: input.language,
      latencyMode: input.latencyMode,
      resumeFromSequence: input.resumeFromSequence,
    },
    initializationSegmentFor: input.initializationSegmentFor,
    socket: createMeetingStreamSocket,
    handlers: input.handlers,
  });
}

/** The seam the capture supervisor is handed, so nothing downstream of it holds a credential. */
export const meetingTranscriptionStreamPort: MeetingTranscriptionStreamPort = {
  capabilities: fetchMeetingTranscriptionCapabilities,
  open: openMeetingTranscriptionStream,
};

function arrayField(payload: unknown, field: string): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const value = (payload as Record<string, unknown>)[field];
  return Array.isArray(value) ? value : [];
}

export function registerMeetingsBridge(): void {
  // Meetings list/detail use the paged endpoints so large accounts and long
  // transcripts never force all rows into the renderer at once.
  ipcMain.handle('meetings:list', async (_event, input: unknown, orgId: unknown) => {
    const opts = input && typeof input === 'object' ? input as { cursor?: string; limit?: number } : {};
    return await requestJson(meetingRequests.list(opts, orgId), 'Could not load meetings');
  });
  ipcMain.handle('meetings:get', async (_event, meetingId: unknown, orgId: unknown) =>
    await requestJson(meetingRequests.detail(meetingId, orgId), 'Could not load the meeting'));
  ipcMain.handle('meetings:overview', async (_event, meetingId: unknown, orgId: unknown) =>
    await requestJson(meetingRequests.overview(meetingId, orgId), 'Could not load the meeting overview'));
  ipcMain.handle('meetings:transcript', async (_event, meetingId: unknown, input: unknown, orgId: unknown) => {
    const opts = input && typeof input === 'object' ? input as { cursor?: string; limit?: number } : {};
    return await requestJson(meetingRequests.transcript(meetingId, opts, orgId), 'Could not load the transcript');
  });
  ipcMain.handle('meetings:create', async (_event, input: unknown, orgId: unknown) =>
    await requestJson(meetingRequests.create(input, orgId), 'Could not create the meeting'));
  ipcMain.handle('meetings:updateSummary', async (_event, meetingId: unknown, summaryMarkdown: unknown, orgId: unknown) =>
    await requestJson(meetingRequests.updateSummary(meetingId, summaryMarkdown, orgId), 'Could not save the summary'));
  ipcMain.handle('meetings:transcribe', async (_event, input: unknown) =>
    await requestJson(meetingRequests.transcribe(input), 'Could not transcribe the audio'));
  ipcMain.handle('meetings:setScope', async (_event, meetingId: unknown, scope: unknown, opts: unknown, orgId: unknown) =>
    await requestJson(meetingRequests.setScope(meetingId, scope, opts, orgId), 'Could not change sharing'));
  ipcMain.handle('meetings:regenerate', async (_event, meetingId: unknown, orgId: unknown) =>
    await requestJson(meetingRequests.regenerate(meetingId, orgId), 'Could not regenerate the summary'));
  ipcMain.handle('meetings:delete', async (_event, meetingId: unknown, orgId: unknown) =>
    await requestJson(meetingRequests.remove(meetingId, orgId), 'Could not delete the meeting'));
  ipcMain.handle('meetings:toggleAction', async (_event, meetingId: unknown, actionId: unknown, done: unknown, orgId: unknown) =>
    await requestJson(meetingRequests.toggleAction(meetingId, actionId, done, orgId), 'Could not update the action item'));
  ipcMain.handle('meetings:actionToTrack', async (_event, meetingId: unknown, actionId: unknown, orgId: unknown) =>
    await requestJson(meetingRequests.trackAction(meetingId, actionId, false, orgId), 'Could not add this action to Track'));
  ipcMain.handle('meetings:actionUntrack', async (_event, meetingId: unknown, actionId: unknown, orgId: unknown) =>
    await requestJson(meetingRequests.trackAction(meetingId, actionId, true, orgId), 'Could not remove this action from Track'));

  // Org-scoped server Track board. This remains separate from desktop's local
  // workspace/GitHub Track mode.
  ipcMain.handle('meetings:serverTracks', async (_event, orgId: unknown) => {
    const payload = await requestJson<unknown>(trackRequests.list(orgId), 'Could not load Track');
    return arrayField(payload, 'items');
  });
  ipcMain.handle('meetings:serverTrackCreate', async (_event, input: unknown, orgId: unknown) =>
    await requestJson(trackRequests.create(input, orgId), 'Could not create the Track item'));
  ipcMain.handle('meetings:serverTrackTransition', async (_event, trackId: unknown, statusCategory: unknown, orgId: unknown) =>
    await requestJson(trackRequests.transition(trackId, statusCategory, orgId), 'Could not move the Track item'));
  // Compatibility for the previously shipped done/reopen renderer method.
  ipcMain.handle('meetings:serverTrackSetDone', async (_event, trackId: unknown, done: unknown, orgId: unknown) => {
    const status: TrackStatusCategory = done === true ? 'completed' : 'todo';
    return await requestJson(trackRequests.transition(trackId, status, orgId), 'Could not update the tracked item');
  });
  ipcMain.handle('action:meetings:serverTrackRemove', async (_event, trackId: unknown, orgId: unknown) =>
    await requestJson(trackRequests.remove(trackId, orgId), 'Could not remove the tracked item'));

  // Teams management and sharing use the same org-scoped backend collection.
  ipcMain.handle('teams:contexts', async () => {
    try {
      const payload = await requestJson<unknown>(teamRequests.contexts(), 'Could not load organizations');
      return arrayField(payload, 'orgs');
    } catch {
      // Organization discovery runs automatically during renderer startup.
      // Offline/signed-out state is represented by no contexts instead of an
      // unhandled IPC rejection; explicit Teams operations still surface errors.
      return [];
    }
  });
  ipcMain.handle('teams:list', async (_event, orgId: unknown) => {
    const payload = await requestJson<unknown>(teamRequests.list(orgId), 'Could not load teams');
    return arrayField(payload, 'teams');
  });
  ipcMain.handle('teams:get', async (_event, teamId: unknown, orgId: unknown) =>
    await requestJson(teamRequests.detail(teamId, orgId), 'Could not load the team'));
  ipcMain.handle('teams:create', async (_event, name: unknown, kind: unknown, orgId: unknown) =>
    await requestJson(teamRequests.create(name, kind, orgId), 'Could not create the team'));
  ipcMain.handle('teams:addMember', async (_event, teamId: unknown, account: unknown, role: unknown, orgId: unknown) =>
    await requestJson(teamRequests.addMember(teamId, account, role, orgId), 'Could not add the team member'));
  ipcMain.handle('teams:removeMember', async (_event, teamId: unknown, userId: unknown, orgId: unknown) =>
    await requestJson(teamRequests.removeMember(teamId, userId, orgId), 'Could not remove the team member'));
  ipcMain.handle('teams:remove', async (_event, teamId: unknown, orgId: unknown) =>
    await requestJson(teamRequests.remove(teamId, orgId), 'Could not delete the team'));
}
