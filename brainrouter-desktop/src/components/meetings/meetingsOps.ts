/** Typed renderer adapter over the privileged Electron Meetings bridge. */
import type {
  CreateMeetingInput,
  CreateTrackInput,
  MeetingDetail,
  MeetingListItem,
  MeetingListPage,
  MeetingOverview,
  MeetingScope,
  MeetingShare,
  MeetingsOps,
  MeetingTranscriptPage,
  TrackItem,
  TrackStatusCategory,
} from "./types.js";

interface MeetingsBridge {
  list(input?: { cursor?: string; limit?: number }, orgId?: string): Promise<unknown>;
  get(id: string, orgId?: string): Promise<unknown>;
  overview(id: string, orgId?: string): Promise<unknown>;
  transcript(id: string, input?: { cursor?: string; limit?: number }, orgId?: string): Promise<unknown>;
  create(input: CreateMeetingInput, orgId?: string): Promise<unknown>;
  updateSummary(id: string, summaryMarkdown: string, orgId?: string): Promise<unknown>;
  transcribe(input: { bytes: Uint8Array; contentType?: string; language?: string }): Promise<unknown>;
  regenerate(id: string, orgId?: string): Promise<unknown>;
  remove?(id: string, orgId?: string): Promise<unknown>;
  setScope(id: string, scope: MeetingScope, opts?: { teamId?: string }, orgId?: string): Promise<unknown>;
  actionToTrack(meetingId: string, actionId: string, orgId?: string): Promise<unknown>;
  actionUntrack(meetingId: string, actionId: string, orgId?: string): Promise<unknown>;
  toggleAction(meetingId: string, actionId: string, done: boolean, orgId?: string): Promise<unknown>;
  serverTracks(orgId?: string): Promise<unknown>;
  serverTrackCreate(input: CreateTrackInput, orgId?: string): Promise<unknown>;
  serverTrackTransition(id: string, statusCategory: TrackStatusCategory, orgId?: string): Promise<unknown>;
  serverTrackSetDone(id: string, done: boolean, orgId?: string): Promise<unknown>;
  serverTrackRemove(id: string, orgId?: string): Promise<unknown>;
}

export class MeetingsUnavailableError extends Error {
  constructor() {
    super("Meetings is unavailable in this build. Restart BrainRouter after updating the desktop app.");
    this.name = "MeetingsUnavailableError";
  }
}

function bridge(): MeetingsBridge | null {
  const root = globalThis as unknown as { brainrouter?: { meetings?: MeetingsBridge } };
  return root.brainrouter?.meetings ?? null;
}

function requireObject<T>(value: unknown, label: string): T {
  if (!value || typeof value !== "object") throw new Error(`The server returned an invalid ${label}.`);
  return value as T;
}

function listPage(value: unknown): MeetingListPage {
  // Accept the pre-pagination bridge shape during rolling desktop upgrades.
  if (Array.isArray(value)) return { meetings: value as MeetingListItem[], nextCursor: null };
  const page = requireObject<Partial<MeetingListPage>>(value, "meetings page");
  if (!Array.isArray(page.meetings)) throw new Error("The server returned an invalid meetings page.");
  return { meetings: page.meetings, nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null };
}

function trackItem(value: unknown): TrackItem {
  const payload = requireObject<{ item?: unknown }>(value, "Track item");
  return requireObject<TrackItem>(payload.item, "Track item");
}

function unavailable(): never { throw new MeetingsUnavailableError(); }

export function createMeetingsOps(): MeetingsOps {
  const api = bridge();
  if (!api) {
    return {
      listPage: async () => unavailable(), list: async () => unavailable(), get: async () => unavailable(), overview: async () => unavailable(),
      transcriptPage: async () => unavailable(), createFromTranscript: async () => unavailable(), updateSummary: async () => unavailable(),
      transcribeAudio: async () => unavailable(), regenerateSummary: async () => unavailable(), deleteMeeting: async () => unavailable(), setScope: async () => unavailable(),
      sendActionToTrack: async () => unavailable(), unsendActionFromTrack: async () => unavailable(), toggleAction: async () => unavailable(),
      serverTracks: async () => unavailable(), serverTrackCreate: async () => unavailable(), serverTrackTransition: async () => unavailable(),
      serverTrackSetDone: async () => unavailable(), serverTrackRemove: async () => unavailable(),
    };
  }

  const getPage = async (input?: { cursor?: string; limit?: number }, orgId?: string) => listPage(await api.list(input, orgId));
  return {
    listPage: getPage,
    list: async (orgId) => (await getPage({ limit: 50 }, orgId)).meetings,
    get: async (id, orgId) => requireObject<MeetingDetail>(await api.get(id, orgId), "meeting"),
    overview: async (id, orgId) => requireObject<MeetingOverview>(await api.overview(id, orgId), "meeting overview"),
    transcriptPage: async (id, input, orgId) => requireObject<MeetingTranscriptPage>(await api.transcript(id, input, orgId), "transcript page"),
    createFromTranscript: async (input, orgId) => requireObject(await api.create(input, orgId), "meeting creation result"),
    updateSummary: async (id, markdown, orgId) => requireObject<MeetingDetail>(await api.updateSummary(id, markdown, orgId), "meeting"),
    transcribeAudio: async (input) => requireObject<{ text: string }>(await api.transcribe(input), "transcription"),
    regenerateSummary: async (id, orgId) => requireObject<MeetingDetail>(await api.regenerate(id, orgId), "meeting"),
    deleteMeeting: async (id, orgId) => { if (!api.remove) unavailable(); await api.remove(id, orgId); },
    setScope: async (id, scope, opts, orgId) => requireObject<MeetingShare>(await api.setScope(id, scope, opts, orgId), "meeting share"),
    sendActionToTrack: async (meetingId, actionId, orgId) => requireObject<{ trackItemId: string }>(await api.actionToTrack(meetingId, actionId, orgId), "Track link"),
    unsendActionFromTrack: async (meetingId, actionId, orgId) => { await api.actionUntrack(meetingId, actionId, orgId); },
    toggleAction: async (meetingId, actionId, done, orgId) => { await api.toggleAction(meetingId, actionId, done, orgId); },
    serverTracks: async (orgId) => {
      const value = await api.serverTracks(orgId);
      if (!Array.isArray(value)) throw new Error("The server returned an invalid Track board.");
      return value as TrackItem[];
    },
    serverTrackCreate: async (input, orgId) => trackItem(await api.serverTrackCreate(input, orgId)),
    serverTrackTransition: async (id, status, orgId) => trackItem(await api.serverTrackTransition(id, status, orgId)),
    serverTrackSetDone: async (id, done, orgId) => { await api.serverTrackSetDone(id, done, orgId); },
    serverTrackRemove: async (id, orgId) => { await api.serverTrackRemove(id, orgId); },
  };
}
