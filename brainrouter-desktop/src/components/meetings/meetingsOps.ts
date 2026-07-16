/**
 * Meetings data bridge (ADR-018). Prefers the host bridge
 * (`window.brainrouter.meetings.*` → host `meetings-*` → backend `MeetingsService`);
 * falls back to an in-memory sample so the mode renders before the backend is wired.
 */

import type {
  MeetingDetail,
  MeetingListItem,
  MeetingScope,
  MeetingShare,
  MeetingsOps,
} from "./types.js";

interface MeetingsBridge {
  list(): Promise<MeetingListItem[]>;
  get(id: string): Promise<MeetingDetail>;
  create(input: { title: string; transcript: string }): Promise<{ id: string }>;
  regenerate(id: string): Promise<void>;
  setScope(id: string, scope: MeetingScope, opts?: { teamId?: string }): Promise<MeetingShare>;
  actionToTrack(meetingId: string, actionId: string): Promise<{ trackItemId: string }>;
  actionUntrack(meetingId: string, actionId: string): Promise<void>;
  toggleAction(meetingId: string, actionId: string, done: boolean): Promise<void>;
}

function bridge(): MeetingsBridge | null {
  const w = globalThis as unknown as { brainrouter?: { meetings?: MeetingsBridge } };
  return w.brainrouter?.meetings ?? null;
}

export function createMeetingsOps(): MeetingsOps {
  const b = bridge();
  if (b) {
    return {
      list: () => b.list(),
      get: (id) => b.get(id),
      createFromTranscript: (input) => b.create(input),
      regenerateSummary: (id) => b.regenerate(id),
      setScope: (id, scope, opts) => b.setScope(id, scope, opts),
      sendActionToTrack: (meetingId, actionId) => b.actionToTrack(meetingId, actionId),
      unsendActionFromTrack: (meetingId, actionId) => b.actionUntrack(meetingId, actionId),
      toggleAction: (meetingId, actionId, done) => b.toggleAction(meetingId, actionId, done),
    };
  }
  return sampleOps();
}

/** In-memory sample used until the host bridge is present (dev + first-run empty states). */
function sampleOps(): MeetingsOps {
  const list: MeetingListItem[] = [
    { id: "m1", title: "Weekly product sync", date: "Jul 14", scope: "private", attendeeCount: 3 },
    { id: "m2", title: "Design review — Meetings UI", date: "Jul 11", scope: "team", attendeeCount: 4 },
    { id: "m3", title: "All-hands Q3 kickoff", date: "Jul 08", scope: "org", attendeeCount: 20 },
    { id: "m4", title: "Customer call — Northwind", date: "Jul 03", scope: "public", attendeeCount: 2 },
  ];
  const details: Record<string, MeetingDetail> = {
    m1: {
      id: "m1",
      title: "Weekly product sync",
      date: "2026-07-14",
      status: "recorded",
      durationMin: 32,
      wordCount: 1240,
      attendees: ["anh", "maya", "jordan"],
      model: { label: "Opus 4.8", effort: "high" },
      summaryMarkdown:
        "The team confirmed Meetings ships as a 4th desktop mode, memory-native with four-level sharing. Server-default transcription was agreed, with a local Whisper fallback for offline privacy.\n### Decisions\n- Meetings is account-gated; offline capture stays as a fallback.\n- Summaries route through the server-managed BrainRouter provider.",
      actionItems: [
        { id: "a1", title: "Wire the sharing scope picker into both surfaces", assignee: "maya", done: false },
        { id: "a2", title: "Finalize the STT microservice Dockerfile", assignee: "jordan", done: false },
      ],
      transcript: [
        { at: "00:12", speaker: "Anh", text: "Let's lock the Meetings placement — desktop mode, dashboard page." },
        { at: "00:31", speaker: "Maya", text: "Sharing needs all four scopes, public with a revocable link." },
        { at: "00:58", speaker: "Jordan", text: "Transcription server-side by default, keep the offline path." },
      ],
      share: { scope: "private" },
    },
  };
  const scopeOf = (id: string): MeetingScope => list.find((m) => m.id === id)?.scope ?? "private";
  const detailFor = (id: string): MeetingDetail =>
    details[id] ?? {
      ...details.m1, id, title: list.find((m) => m.id === id)?.title ?? "Meeting",
      share: { scope: scopeOf(id), publicUrl: scopeOf(id) === "public" ? "brainrouter.ai/m/9fK2qX" : undefined },
    };
  let trackSeq = 0;
  return {
    async list() { return list; },
    async get(id) { return detailFor(id); },
    async createFromTranscript() { return { id: "m1" }; },
    async regenerateSummary() { /* no-op in sample */ },
    async setScope(_id, scope) {
      return { scope, publicUrl: scope === "public" ? "brainrouter.ai/m/9fK2qX" : undefined, expiresAt: scope === "public" ? "in 30 days" : undefined };
    },
    async sendActionToTrack() { return { trackItemId: `wi-${++trackSeq}` }; },
    async unsendActionFromTrack() { /* no-op in sample */ },
    async toggleAction() { /* no-op in sample */ },
  };
}
