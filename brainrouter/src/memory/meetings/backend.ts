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
import { redactSensitiveMemoryText } from "../util/redaction.js";
import { createTrack, untrackBySourceRef, type TrackItemRow } from "../track/backend.js";
import type { CreateMeetingInput, MeetingListCursor, MeetingRow, MeetingScope, MeetingTranscriptSegment } from "../store/postgres/queries/meetingsQueries.js";

interface MeetingsStore {
  createMeeting(m: CreateMeetingInput): Promise<void>;
  listMeetings(orgId: string, userId: string, limit?: number): Promise<MeetingRow[]>;
  listMeetingsPage(orgId: string, userId: string, limit?: number, cursor?: MeetingListCursor): Promise<MeetingRow[]>;
  getMeeting(orgId: string, userId: string, id: string): Promise<MeetingRow | null>;
  getMeetingOverview(orgId: string, userId: string, id: string): Promise<MeetingRow | null>;
  getMeetingTranscriptText(orgId: string, userId: string, id: string): Promise<string | null>;
  insertMeetingTranscriptSegments(meetingId: string, segments: MeetingTranscriptSegment[]): Promise<void>;
  listMeetingTranscriptSegments(orgId: string, userId: string, id: string, cursor?: number, limit?: number): Promise<MeetingTranscriptSegment[]>;
  setMeetingScope(id: string, userId: string, scope: MeetingScope, teamId: string | null): Promise<boolean>;
  createMeetingShareToken(s: { token: string; meetingId: string; orgId: string; createdBy: string; expiresAt?: string }): Promise<void>;
  revokeMeetingShareTokens(meetingId: string): Promise<number>;
  getMeetingByShareToken(token: string): Promise<MeetingRow | null>;
  getMeetingActiveShareToken(meetingId: string): Promise<{ token: string; expiresAt: string | null } | null>;
  updateMeetingSummary(id: string, userId: string, summaryMarkdown: string, actionItems: MeetingRow["actionItems"]): Promise<boolean>;
  updateMeetingActionItems(id: string, userId: string, actionItems: MeetingRow["actionItems"]): Promise<boolean>;
  setMeetingSummaryStatus(id: string, userId: string, status: MeetingRow["summaryStatus"], error?: string | null): Promise<boolean>;
  setMeetingSummaryRecords(id: string, userId: string, summaryRecordId: string | null, transcriptSourceId: string | null): Promise<boolean>;
}
const store = (): MeetingsStore => memoryEngine.store as unknown as MeetingsStore;

export class MeetingsAccountRequiredError extends Error {
  constructor() { super("Meetings requires a BrainRouter sign-in."); this.name = "MeetingsAccountRequiredError"; }
}
function requireAccount(userId?: string, orgId?: string): asserts userId is string {
  if (!userId || !orgId) throw new MeetingsAccountRequiredError();
}

export interface MeetingListDTO { id: string; title: string; date: string; scope: MeetingScope; attendeeCount: number; summaryStatus: MeetingRow["summaryStatus"] }
export interface MeetingDetailDTO {
  id: string; title: string; date: string; status: string; durationMin?: number; wordCount?: number;
  attendees: string[]; model?: { label: string; effort?: string };
  summaryMarkdown: string; actionItems: MeetingRow["actionItems"];
  transcript: Array<{ at: string; speaker: string; text: string }>;
  share: MeetingShareDTO;
  summaryStatus: MeetingRow["summaryStatus"]; summaryError?: string;
}
export interface MeetingShareDTO { scope: MeetingScope; teamId?: string; publicUrl?: string; expiresAt?: string }
export interface MeetingTranscriptPageDTO {
  segments: Array<{ ordinal: number; at: string; speaker: string; text: string }>;
  total: number;
  nextCursor: string | null;
}

function baseUrl(): string {
  return (process.env.BRAINROUTER_PUBLIC_URL ?? "").replace(/\/+$/, "");
}

/**
 * Split a transcript into displayable lines. Speech-to-text output is plain prose
 * with NO speaker labels (meetily-style — we deliberately don't attribute
 * speakers), so we never infer a speaker: a plain sentence with an early colon
 * ("Reminder: ship Friday") stays intact. A leading "[mm:ss]" timestamp is kept
 * only if the source already includes one.
 */
function parseTranscript(text: string, maxLines = 500): MeetingDetailDTO["transcript"] {
  const lines: MeetingDetailDTO["transcript"] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const ts = trimmed.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+)$/);
    if (ts) lines.push({ at: ts[1] ?? "", speaker: "", text: (ts[2] ?? "").trim() });
    else lines.push({ at: "", speaker: "", text: trimmed });
    if (lines.length >= maxLines) break;
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

type MeetingSummaryTemplate = "general" | "standup" | "one-on-one" | "retrospective";

async function summarize(orgId: string, title: string, transcript: string, template: MeetingSummaryTemplate = "general"): Promise<{ markdown: string; actionItems: MeetingRow["actionItems"] }> {
  // Internal sub-agent runner bound to the org's OWN LLM provider (BYOK / personal).
  // An admin can assign a dedicated model to the meeting-summary role via
  // agentModels["meeting-summary"], else the org's default LLM provider is used.
  // Server-managed models are NOT consulted here — those only serve the desktop.
  const runner = await memoryEngine.modelRunner("meeting-summary", orgId);
  const templateInstruction: Record<MeetingSummaryTemplate, string> = {
    general: "Lead with a concise overview, then decisions and action items.",
    standup: "Organize the notes under Progress, Blockers, Next steps, and Action items.",
    "one-on-one": "Organize the notes under Discussion, Feedback, Commitments, and Action items.",
    retrospective: "Organize the notes under What went well, What did not, Experiments, and Action items.",
  };
  const systemPrompt = `You summarize meeting transcripts. ${templateInstruction[template]} Use concise markdown and format each action item as '- <task> — @<assignee>'. No preamble.`;
  // Throws on model failure (e.g. LLM_NOT_CONFIGURED) so the background job marks
  // the summary 'failed' — the caller polls status and can Regenerate.
  const markdown = await runner.run({ systemPrompt, prompt: `Meeting: ${title}\n\nTranscript:\n${transcript.slice(0, 40_000)}`, taskId: `meeting-summary:${orgId}` });
  return { markdown: markdown.trim(), actionItems: parseActionItems(markdown) };
}

/**
 * Generate (or regenerate) the summary + recall-provenance records in the
 * BACKGROUND, then flip summary_status to ready/failed. It runs on the server, so
 * a client refresh never loses progress — the client just polls the status.
 */
function generateSummaryInBackground(args: {
  id: string; userId: string; orgId: string; title: string; transcript: string;
  date?: string; attendees?: string[]; scope?: MeetingScope; previousActionItems?: MeetingRow["actionItems"]; template?: MeetingSummaryTemplate;
}): void {
  void (async () => {
    try {
      const { markdown, actionItems } = await summarize(args.orgId, args.title, args.transcript, args.template);
      const previous = new Map((args.previousActionItems ?? []).map((item) => [item.title.toLowerCase(), item]));
      const merged = actionItems.map((item) => {
        const before = previous.get(item.title.toLowerCase());
        return before ? { ...item, done: before.done, trackItemId: before.trackItemId } : item;
      });
      await store().updateMeetingSummary(args.id, args.userId, markdown, merged); // sets summary_status='ready'
      // Memory-native (D1): recallable summary + transcript source, linked for provenance. Best-effort.
      try {
        const hash = createHash("sha256").update(args.transcript).digest("hex");
        const src = await ingestSource(memoryEngine.store as unknown as SourceIngestStore, {
          userId: args.userId, orgId: args.orgId, workspaceTag: null, kind: "transcript",
          uri: null, hash, title: args.title, metadata: { meetingId: args.id },
        }, args.transcript);
        const rec = await memoryEngine.upsertEngineeringMemory({
          userId: args.userId, type: "episodic", content: `MEETING — ${args.title}\n\n${markdown}`,
          sourceKind: "model_inference",
          metadata: { kind: "meeting", meetingId: args.id, title: args.title, date: args.date, attendees: args.attendees ?? [], sourceId: src.document.id },
        });
        await (memoryEngine.store as unknown as { linkRecordSources(u: string, r: string, c: string[]): Promise<void> })
          .linkRecordSources(args.userId, rec.id, src.chunks.map((c) => c.id));
        await store().setMeetingSummaryRecords(args.id, args.userId, rec.id, src.document.id);
        if (args.scope && args.scope !== "private") {
          await memoryEngine.sharing.setMemoryVisibility(rec.id, args.userId, args.orgId, "org").catch(() => {});
        }
      } catch { /* provenance is best-effort; the summary + status are already persisted */ }
    } catch (error) {
      await store().setMeetingSummaryStatus(args.id, args.userId, "failed", error instanceof Error ? error.message : "Summary generation failed.").catch(() => {});
    }
  })();
}

export async function createMeeting(input: {
  userId: string; orgId: string; title: string; transcript: string; scope?: MeetingScope; teamId?: string; date?: string; attendees?: string[]; template?: MeetingSummaryTemplate;
}): Promise<{ id: string; summaryStatus: MeetingRow["summaryStatus"] }> {
  requireAccount(input.userId, input.orgId);
  if (!input.transcript.trim()) throw new Error("Cannot record a meeting with an empty transcript.");
  const scope = input.scope ?? "private";
  assertScopeParams(scope, input.teamId);
  const id = `meeting-${randomUUID()}`;

  // Persist the meeting immediately with an empty summary + 'processing' status, then
  // generate the notes in the background — the request returns fast and a client
  // refresh never loses progress (the server keeps summarizing; the client polls).
  await store().createMeeting({
    id, orgId: input.orgId, userId: input.userId, title: input.title, meetingDate: input.date,
    status: "imported", wordCount: input.transcript.trim().split(/\s+/).length, attendees: input.attendees ?? [],
    transcriptText: input.transcript, summaryMarkdown: "", actionItems: [],
    scope: "private", teamId: undefined, summaryStatus: "processing",
  });
  if (scope !== "private") await setScope({ userId: input.userId, orgId: input.orgId, id, scope, teamId: input.teamId });
  generateSummaryInBackground({ id, userId: input.userId, orgId: input.orgId, title: input.title, transcript: input.transcript, date: input.date, attendees: input.attendees, scope, template: input.template });
  return { id, summaryStatus: "processing" };
}

export async function listMeetings(userId: string, orgId: string): Promise<MeetingListDTO[]> {
  requireAccount(userId, orgId);
  const rows = await store().listMeetings(orgId, userId);
  return rows.map((r) => ({ id: r.id, title: r.title, date: r.meetingDate ?? r.createdAt.slice(0, 10), scope: r.scope, attendeeCount: r.attendees.length, summaryStatus: r.summaryStatus }));
}

export async function listMeetingsPage(userId: string, orgId: string, cursorValue?: string, limit = 50): Promise<{ meetings: MeetingListDTO[]; nextCursor: string | null }> {
  requireAccount(userId, orgId);
  let cursor: MeetingListCursor | undefined;
  if (cursorValue) {
    try {
      const decoded = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8")) as MeetingListCursor;
      if (!decoded.id || !decoded.createdAt || !Number.isFinite(Date.parse(decoded.createdAt))) throw new Error("bad cursor");
      cursor = decoded;
    } catch { throw new Error("Invalid meetings cursor"); }
  }
  const size = Math.min(Math.max(limit, 1), 100);
  const rows = await store().listMeetingsPage(orgId, userId, size + 1, cursor);
  const hasMore = rows.length > size;
  const page = rows.slice(0, size);
  const last = page.at(-1);
  return {
    meetings: page.map((r) => ({ id: r.id, title: r.title, date: r.meetingDate ?? r.createdAt.slice(0, 10), scope: r.scope, attendeeCount: r.attendees.length, summaryStatus: r.summaryStatus })),
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id }), "utf8").toString("base64url") : null,
  };
}

export async function getMeeting(userId: string, orgId: string, id: string): Promise<MeetingDetailDTO | null> {
  requireAccount(userId, orgId);
  const r = await store().getMeeting(orgId, userId, id);
  return r ? await toDetail(r) : null;
}

export async function getMeetingOverview(userId: string, orgId: string, id: string): Promise<Omit<MeetingDetailDTO, "transcript"> | null> {
  requireAccount(userId, orgId);
  const r = await store().getMeetingOverview(orgId, userId, id);
  if (!r) return null;
  const detail = await toDetail(r);
  const { transcript: _transcript, ...overview } = detail;
  return overview;
}

export async function getMeetingTranscriptPage(userId: string, orgId: string, id: string, cursor = 0, limit = 100): Promise<MeetingTranscriptPageDTO | null> {
  requireAccount(userId, orgId);
  const size = Math.min(Math.max(limit, 1), 200);
  let rows = await store().listMeetingTranscriptSegments(orgId, userId, id, cursor, size + 1);
  if (!rows.length && cursor === 0) {
    const text = await store().getMeetingTranscriptText(orgId, userId, id);
    if (text === null) return null;
    const legacy = parseTranscript(text, Number.POSITIVE_INFINITY).map((segment, ordinal) => ({ ordinal, ...segment }));
    await store().insertMeetingTranscriptSegments(id, legacy);
    rows = await store().listMeetingTranscriptSegments(orgId, userId, id, cursor, size + 1);
  }
  const hasMore = rows.length > size;
  const page = rows.slice(0, size);
  const total = rows[0]?.total ?? 0;
  const last = page.at(-1);
  return { segments: page.map(({ total: _total, ...segment }) => segment), total, nextCursor: hasMore && last ? String(last.ordinal + 1) : null };
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
    summaryStatus: r.summaryStatus, summaryError: r.summaryError ?? undefined,
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
    share.expiresAt = expiresAt; // ISO — matches the shape toDetail() returns (was the literal "in 30 days")
  }
  return share;
}

/** Owner-only: re-run summarization on the stored transcript (D5 lifecycle), in
 *  the BACKGROUND. Idempotent — a second call while one is already running returns
 *  the in-progress meeting untouched (so a double-click can't double-summarize). */
export async function regenerateSummary(userId: string, orgId: string, id: string): Promise<MeetingDetailDTO | null> {
  requireAccount(userId, orgId);
  const row = await store().getMeeting(orgId, userId, id);
  if (!row || row.userId !== userId) return null;
  // Already running (and not stuck): don't start a second pass.
  if (row.summaryStatus === "processing" || row.summaryStatus === "queued") return await toDetail(row);
  await store().setMeetingSummaryStatus(id, userId, "processing");
  generateSummaryInBackground({ id, userId, orgId, title: row.title, transcript: row.transcriptText, scope: row.scope, previousActionItems: row.actionItems });
  const updated = await store().getMeeting(orgId, userId, id);
  return updated ? await toDetail(updated) : null;
}

/** Owner-only manual summary edit (Notion-style). Preserves action items + their
 *  done/track state; runs through the redaction chokepoint (public shares serve
 *  the summary column raw). Sets status back to 'ready'. */
export async function updateSummary(userId: string, orgId: string, id: string, summaryMarkdown: string): Promise<MeetingDetailDTO | null> {
  requireAccount(userId, orgId);
  const row = await store().getMeeting(orgId, userId, id);
  if (!row || row.userId !== userId) return null;
  const clean = redactSensitiveMemoryText(summaryMarkdown).slice(0, 40_000);
  const ok = await store().updateMeetingSummary(id, userId, clean, row.actionItems);
  if (!ok) return null;
  const updated = await store().getMeeting(orgId, userId, id);
  return updated ? await toDetail(updated) : null;
}

/** Owner-only: persist an action item's done state (or a Track link).
 *  `trackItemId: null` CLEARS the link (untrack); omitting it leaves it unchanged. */
export async function setActionItemState(userId: string, orgId: string, id: string, actionId: string, patch: { done?: boolean; trackItemId?: string | null }): Promise<boolean> {
  requireAccount(userId, orgId);
  const row = await store().getMeeting(orgId, userId, id);
  if (!row || row.userId !== userId) return false;
  let found = false;
  const next = row.actionItems.map((item) => {
    if (item.id !== actionId) return item;
    found = true;
    const merged = { ...item, ...(patch.done !== undefined ? { done: patch.done } : {}) };
    // `undefined` is dropped by JSON.stringify on persist, so null clears the link.
    if (patch.trackItemId !== undefined) merged.trackItemId = patch.trackItemId || undefined;
    return merged;
  });
  if (!found) return false;
  return store().updateMeetingActionItems(id, userId, next);
}

/** Track a meeting action item — create a REAL, org-scoped Track work item (idempotent
 *  per meeting+action) and link it back onto the action. Both desktop and dashboard
 *  call this, so the resulting item is viewable + syncs everywhere. */
export async function trackMeetingAction(userId: string, orgId: string, meetingId: string, actionId: string): Promise<{ trackItemId: string; item: TrackItemRow } | null> {
  requireAccount(userId, orgId);
  const row = await store().getMeeting(orgId, userId, meetingId);
  if (!row || row.userId !== userId) return null;
  const action = row.actionItems.find((a) => a.id === actionId);
  if (!action) return null;
  const item = await createTrack(orgId, userId, {
    title: action.title,
    assignee: action.assignee ?? null,
    source: "meeting-action",
    sourceRef: `${meetingId}:${actionId}`,
    statusCategory: action.done ? "completed" : "todo",
  });
  await store().updateMeetingActionItems(meetingId, userId, row.actionItems.map((a) => a.id === actionId ? { ...a, trackItemId: item.id } : a));
  return { trackItemId: item.id, item };
}

/** Untrack a meeting action — delete its linked Track work item and clear the link. */
export async function untrackMeetingAction(userId: string, orgId: string, meetingId: string, actionId: string): Promise<boolean> {
  requireAccount(userId, orgId);
  const row = await store().getMeeting(orgId, userId, meetingId);
  if (!row || row.userId !== userId) return false;
  if (!row.actionItems.some((a) => a.id === actionId)) return false;
  await untrackBySourceRef(orgId, `${meetingId}:${actionId}`);
  await store().updateMeetingActionItems(meetingId, userId, row.actionItems.map((a) => a.id === actionId ? { ...a, trackItemId: undefined } : a));
  return true;
}

/** Public read — the redacted summary only, for an active share token. No auth. */
export async function getByShareToken(token: string): Promise<{ title: string; date: string; summaryMarkdown: string } | null> {
  const r = await store().getMeetingByShareToken(token);
  if (!r) return null;
  return { title: r.title, date: r.meetingDate ?? r.createdAt.slice(0, 10), summaryMarkdown: r.summaryMarkdown };
}
