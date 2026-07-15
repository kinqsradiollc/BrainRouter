/**
 * Meetings backend (ADR-018) — the real data plane behind /api/meetings.
 *
 * Memory-native (D1): the transcript is ingested as a `SourceDocument(kind:"transcript")`
 * and the summary as a recallable `CognitiveRecord` (through the redaction chokepoint),
 * linked for provenance; a thin `meetings` index row drives list/detail. Summaries route
 * through the org's own LLM provider (D2, via memoryEngine.modelRunner) — server-managed
 * models are desktop-only. Sharing is the four-level ladder (D8) with revocable public tokens.
 */
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { memoryEngine } from "../engine.js";
import { ingestSource, type SourceIngestStore } from "../source/ingest.js";
import { isPublicScope, isScopeDowngrade, scopeToBackendVisibility, assertScopeParams } from "./sharing.js";
import type { CreateMeetingInput, MeetingRow, MeetingScope } from "../store/postgres/queries/meetingsQueries.js";

interface MeetingsStore {
  createMeeting(m: CreateMeetingInput): Promise<void>;
  listMeetings(orgId: string, userId: string, limit?: number): Promise<MeetingRow[]>;
  getMeeting(orgId: string, userId: string, id: string): Promise<MeetingRow | null>;
  setMeetingScope(id: string, userId: string, scope: MeetingScope, teamId: string | null): Promise<boolean>;
  createMeetingShareToken(s: { token: string; meetingId: string; orgId: string; createdBy: string; expiresAt?: string }): Promise<void>;
  revokeMeetingShareTokens(meetingId: string): Promise<number>;
  getMeetingByShareToken(token: string): Promise<MeetingRow | null>;
  getMeetingActiveShareToken(meetingId: string): Promise<{ token: string; expiresAt: string | null } | null>;
  updateMeetingSummary(id: string, userId: string, summaryMarkdown: string, actionItems: MeetingRow["actionItems"]): Promise<boolean>;
  updateMeetingActionItems(id: string, userId: string, actionItems: MeetingRow["actionItems"]): Promise<boolean>;
}
const store = (): MeetingsStore => memoryEngine.store as unknown as MeetingsStore;

export class MeetingsAccountRequiredError extends Error {
  constructor() { super("Meetings requires a BrainRouter sign-in."); this.name = "MeetingsAccountRequiredError"; }
}
function requireAccount(userId?: string, orgId?: string): asserts userId is string {
  if (!userId || !orgId) throw new MeetingsAccountRequiredError();
}

export interface MeetingListDTO { id: string; title: string; date: string; scope: MeetingScope; attendeeCount: number }
export interface MeetingDetailDTO {
  id: string; title: string; date: string; status: string; durationMin?: number; wordCount?: number;
  attendees: string[]; model?: { label: string; effort?: string };
  summaryMarkdown: string; actionItems: MeetingRow["actionItems"];
  transcript: Array<{ at: string; speaker: string; text: string }>;
  share: MeetingShareDTO;
}
export interface MeetingShareDTO { scope: MeetingScope; teamId?: string; publicUrl?: string; expiresAt?: string }

function baseUrl(): string {
  return (process.env.BRAINROUTER_PUBLIC_URL ?? "").replace(/\/+$/, "");
}

/** Parse a "[mm:ss] Speaker: text" style transcript into structured lines (best-effort). */
function parseTranscript(text: string): MeetingDetailDTO["transcript"] {
  const lines: MeetingDetailDTO["transcript"] = [];
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?)?\s*([A-Za-z][\w .'-]{0,40}?):\s*(.+)$/);
    if (m) lines.push({ at: m[1] ?? "", speaker: (m[2] ?? "").trim(), text: (m[3] ?? "").trim() });
    else if (raw.trim()) lines.push({ at: "", speaker: "", text: raw.trim() });
    if (lines.length >= 500) break;
  }
  return lines;
}

function parseActionItems(md: string): MeetingRow["actionItems"] {
  const items: MeetingRow["actionItems"] = [];
  let inSection = false;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (/^#{1,4}\s/.test(line)) { inSection = /action/i.test(line); continue; }
    if (!inSection) continue;
    const m = line.match(/^[-*]\s+(.*)$/);
    if (!m) continue;
    const body = m[1];
    const who = body.match(/[—-]\s*@?([\w.-]+)\s*$/);
    items.push({
      id: `ai-${items.length + 1}`,
      title: who ? body.slice(0, who.index).replace(/[—-]\s*$/, "").trim() : body.trim(),
      assignee: who?.[1],
      done: false,
    });
    if (items.length >= 50) break;
  }
  return items;
}

async function summarize(orgId: string, title: string, transcript: string): Promise<{ markdown: string; actionItems: MeetingRow["actionItems"] }> {
  // Internal sub-agent runner bound to the org's OWN LLM provider (BYOK / personal).
  // An admin can assign a dedicated model to the meeting-summary role via
  // agentModels["meeting-summary"], else the org's default LLM provider is used.
  // Server-managed models are NOT consulted here — those only serve the desktop.
  const runner = await memoryEngine.modelRunner("meeting-summary", orgId);
  const systemPrompt =
    "You summarize meeting transcripts. Return concise markdown: a short paragraph, then a '### Decisions' " +
    "bullet list, then a '### Action items' bullet list where each item is '- <task> — @<assignee>'. No preamble.";
  let markdown: string;
  try {
    markdown = await runner.run({ systemPrompt, prompt: `Meeting: ${title}\n\nTranscript:\n${transcript.slice(0, 40_000)}`, taskId: `meeting-summary:${orgId}` });
  } catch {
    markdown = "Summary pending — the transcript was captured, but no summary model responded. "
      + "An organization admin can configure the org's LLM provider under Settings → Models & providers "
      + "(or assign a model to the meeting-summary role), then use Regenerate.";
  }
  return { markdown: markdown.trim(), actionItems: parseActionItems(markdown) };
}

export async function createMeeting(input: {
  userId: string; orgId: string; title: string; transcript: string; scope?: MeetingScope; teamId?: string; date?: string; attendees?: string[];
}): Promise<{ id: string }> {
  requireAccount(input.userId, input.orgId);
  if (!input.transcript.trim()) throw new Error("Cannot record a meeting with an empty transcript.");
  const scope = input.scope ?? "private";
  assertScopeParams(scope, input.teamId);
  const id = `meeting-${randomUUID()}`;

  const { markdown, actionItems } = await summarize(input.orgId, input.title, input.transcript);

  // Memory-native (D1): recallable summary record + transcript source, linked for provenance.
  let summaryRecordId: string | undefined;
  let transcriptSourceId: string | undefined;
  try {
    const hash = createHash("sha256").update(input.transcript).digest("hex");
    const src = await ingestSource(memoryEngine.store as unknown as SourceIngestStore, {
      userId: input.userId, orgId: input.orgId, workspaceTag: null, kind: "transcript",
      uri: null, hash, title: input.title, metadata: { meetingId: id },
    }, input.transcript);
    transcriptSourceId = src.document.id;
    const rec = await memoryEngine.upsertEngineeringMemory({
      userId: input.userId, type: "episodic", content: `MEETING — ${input.title}\n\n${markdown}`,
      sourceKind: "model_inference",
      metadata: { kind: "meeting", meetingId: id, title: input.title, date: input.date, attendees: input.attendees ?? [], sourceId: src.document.id },
    });
    summaryRecordId = rec.id;
    await (memoryEngine.store as unknown as { linkRecordSources(userId: string, recordId: string, chunkIds: string[]): Promise<void> })
      .linkRecordSources(input.userId, rec.id, src.chunks.map((c) => c.id));
  } catch {
    // Non-fatal: the index row below still gives a working meeting; recall provenance is best-effort.
  }

  await store().createMeeting({
    id, orgId: input.orgId, userId: input.userId, title: input.title, meetingDate: input.date,
    status: "imported", wordCount: input.transcript.trim().split(/\s+/).length, attendees: input.attendees ?? [],
    transcriptText: input.transcript, summaryMarkdown: markdown, actionItems,
    summaryRecordId, transcriptSourceId, scope: "private", teamId: undefined,
  });
  if (scope !== "private") await setScope({ userId: input.userId, orgId: input.orgId, id, scope, teamId: input.teamId });
  return { id };
}

export async function listMeetings(userId: string, orgId: string): Promise<MeetingListDTO[]> {
  requireAccount(userId, orgId);
  const rows = await store().listMeetings(orgId, userId);
  return rows.map((r) => ({ id: r.id, title: r.title, date: r.meetingDate ?? r.createdAt.slice(0, 10), scope: r.scope, attendeeCount: r.attendees.length }));
}

export async function getMeeting(userId: string, orgId: string, id: string): Promise<MeetingDetailDTO | null> {
  requireAccount(userId, orgId);
  const r = await store().getMeeting(orgId, userId, id);
  return r ? await toDetail(r) : null;
}

async function toDetail(r: MeetingRow): Promise<MeetingDetailDTO> {
  const share: MeetingShareDTO = { scope: r.scope, teamId: r.teamId ?? undefined };
  if (r.scope === "public") {
    const tok = await store().getMeetingActiveShareToken(r.id);
    if (tok) { share.publicUrl = `${baseUrl()}/m/${tok.token}`; share.expiresAt = tok.expiresAt ?? undefined; }
  }
  return {
    id: r.id, title: r.title, date: r.meetingDate ?? r.createdAt.slice(0, 10), status: r.status,
    durationMin: r.durationMin ?? undefined, wordCount: r.wordCount ?? undefined, attendees: r.attendees,
    model: r.modelLabel ? { label: r.modelLabel, effort: r.modelEffort ?? undefined } : undefined,
    summaryMarkdown: r.summaryMarkdown, actionItems: r.actionItems, transcript: parseTranscript(r.transcriptText),
    share,
  };
}

/** Owner-only scope change (D8). Downgrading out of public revokes the token first. */
export async function setScope(params: { userId: string; orgId: string; id: string; scope: MeetingScope; teamId?: string; from?: MeetingScope }): Promise<MeetingShareDTO> {
  requireAccount(params.userId, params.orgId);
  assertScopeParams(params.scope, params.teamId);
  if (params.from && isPublicScope(params.from) && isScopeDowngrade(params.from, params.scope)) {
    await store().revokeMeetingShareTokens(params.id);
  } else if (!isPublicScope(params.scope)) {
    await store().revokeMeetingShareTokens(params.id);
  }
  const ok = await store().setMeetingScope(params.id, params.userId, params.scope, params.scope === "team" ? params.teamId ?? null : null);
  if (!ok) throw new Error("Not the owner of this meeting, or it no longer exists.");

  // Promote the recallable summary record to the matching memory visibility.
  const row = await store().getMeeting(params.orgId, params.userId, params.id);
  if (row?.summaryRecordId) {
    await memoryEngine.sharing.setMemoryVisibility(row.summaryRecordId, params.userId, params.orgId, scopeToBackendVisibility(params.scope) === "private" ? "private" : "org");
  }

  const share: MeetingShareDTO = { scope: params.scope, teamId: params.scope === "team" ? params.teamId : undefined };
  if (isPublicScope(params.scope)) {
    const token = randomBytes(18).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 864e5).toISOString();
    await store().createMeetingShareToken({ token, meetingId: params.id, orgId: params.orgId, createdBy: params.userId, expiresAt });
    share.publicUrl = `${baseUrl()}/m/${token}`;
    share.expiresAt = "in 30 days";
  }
  return share;
}

/** Owner-only: re-run summarization on the stored transcript (D5 lifecycle). */
export async function regenerateSummary(userId: string, orgId: string, id: string): Promise<MeetingDetailDTO | null> {
  requireAccount(userId, orgId);
  const row = await store().getMeeting(orgId, userId, id);
  if (!row || row.userId !== userId) return null;
  const { markdown, actionItems } = await summarize(orgId, row.title, row.transcriptText);
  // Preserve done/track state for action items that survived the regeneration.
  const previous = new Map(row.actionItems.map((item) => [item.title.toLowerCase(), item]));
  const merged = actionItems.map((item) => {
    const before = previous.get(item.title.toLowerCase());
    return before ? { ...item, done: before.done, trackItemId: before.trackItemId } : item;
  });
  const ok = await store().updateMeetingSummary(id, userId, markdown, merged);
  if (!ok) return null;
  const updated = await store().getMeeting(orgId, userId, id);
  return updated ? await toDetail(updated) : null;
}

/** Owner-only: persist an action item's done state (or a Track link). */
export async function setActionItemState(userId: string, orgId: string, id: string, actionId: string, patch: { done?: boolean; trackItemId?: string }): Promise<boolean> {
  requireAccount(userId, orgId);
  const row = await store().getMeeting(orgId, userId, id);
  if (!row || row.userId !== userId) return false;
  let found = false;
  const next = row.actionItems.map((item) => {
    if (item.id !== actionId) return item;
    found = true;
    return { ...item, ...(patch.done !== undefined ? { done: patch.done } : {}), ...(patch.trackItemId ? { trackItemId: patch.trackItemId } : {}) };
  });
  if (!found) return false;
  return store().updateMeetingActionItems(id, userId, next);
}

/** Public read — the redacted summary only, for an active share token. No auth. */
export async function getByShareToken(token: string): Promise<{ title: string; date: string; summaryMarkdown: string } | null> {
  const r = await store().getMeetingByShareToken(token);
  if (!r) return null;
  return { title: r.title, date: r.meetingDate ?? r.createdAt.slice(0, 10), summaryMarkdown: r.summaryMarkdown };
}
