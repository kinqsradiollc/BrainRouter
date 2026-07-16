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
  list(input?: { cursor?: string; limit?: number }): Promise<unknown>;
  get(id: string): Promise<unknown>;
  overview(id: string): Promise<unknown>;
  transcript(id: string, input?: { cursor?: string; limit?: number }): Promise<unknown>;
  create(input: CreateMeetingInput): Promise<unknown>;
  updateSummary(id: string, summaryMarkdown: string): Promise<unknown>;
  transcribe(input: { bytes: Uint8Array; contentType?: string; language?: string }): Promise<unknown>;
  regenerate(id: string): Promise<unknown>;
  setScope(id: string, scope: MeetingScope, opts?: { teamId?: string }): Promise<unknown>;
  actionToTrack(meetingId: string, actionId: string): Promise<unknown>;
  actionUntrack(meetingId: string, actionId: string): Promise<unknown>;
  toggleAction(meetingId: string, actionId: string, done: boolean): Promise<unknown>;
  serverTracks(): Promise<unknown>;
  serverTrackCreate(input: CreateTrackInput): Promise<unknown>;
  serverTrackTransition(id: string, statusCategory: TrackStatusCategory): Promise<unknown>;
  serverTrackSetDone(id: string, done: boolean): Promise<unknown>;
  serverTrackRemove(id: string): Promise<unknown>;
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
      transcribeAudio: async () => unavailable(), regenerateSummary: async () => unavailable(), setScope: async () => unavailable(),
      sendActionToTrack: async () => unavailable(), unsendActionFromTrack: async () => unavailable(), toggleAction: async () => unavailable(),
      serverTracks: async () => unavailable(), serverTrackCreate: async () => unavailable(), serverTrackTransition: async () => unavailable(),
      serverTrackSetDone: async () => unavailable(), serverTrackRemove: async () => unavailable(),
    };
  }

  const getPage = async (input?: { cursor?: string; limit?: number }) => listPage(await api.list(input));
  return {
    listPage: getPage,
    list: async () => (await getPage({ limit: 50 })).meetings,
    get: async (id) => requireObject<MeetingDetail>(await api.get(id), "meeting"),
    overview: async (id) => requireObject<MeetingOverview>(await api.overview(id), "meeting overview"),
    transcriptPage: async (id, input) => requireObject<MeetingTranscriptPage>(await api.transcript(id, input), "transcript page"),
    createFromTranscript: async (input) => requireObject(await api.create(input), "meeting creation result"),
    updateSummary: async (id, markdown) => requireObject<MeetingDetail>(await api.updateSummary(id, markdown), "meeting"),
    transcribeAudio: async (input) => requireObject<{ text: string }>(await api.transcribe(input), "transcription"),
    regenerateSummary: async (id) => requireObject<MeetingDetail>(await api.regenerate(id), "meeting"),
    setScope: async (id, scope, opts) => requireObject<MeetingShare>(await api.setScope(id, scope, opts), "meeting share"),
    sendActionToTrack: async (meetingId, actionId) => requireObject<{ trackItemId: string }>(await api.actionToTrack(meetingId, actionId), "Track link"),
    unsendActionFromTrack: async (meetingId, actionId) => { await api.actionUntrack(meetingId, actionId); },
    toggleAction: async (meetingId, actionId, done) => { await api.toggleAction(meetingId, actionId, done); },
    serverTracks: async () => {
      const value = await api.serverTracks();
      if (!Array.isArray(value)) throw new Error("The server returned an invalid Track board.");
      return value as TrackItem[];
    },
    serverTrackCreate: async (input) => trackItem(await api.serverTrackCreate(input)),
    serverTrackTransition: async (id, status) => trackItem(await api.serverTrackTransition(id, status)),
    serverTrackSetDone: async (id, done) => { await api.serverTrackSetDone(id, done); },
    serverTrackRemove: async (id) => { await api.serverTrackRemove(id); },
  };
}
