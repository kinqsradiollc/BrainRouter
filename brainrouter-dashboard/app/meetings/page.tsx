"use client";

/**
 * Meetings — the dashboard mirror of the desktop Meetings mode (ADR-018). Lists the
 * account's recallable meeting summaries and shows a detail with the same model +
 * four-level sharing vocabulary (Private / Team / Org / Public). Real, org-scoped
 * data from the backend at :3747 (/api/meetings) using the signed-in account's JWT
 * — the same dataset the desktop sees for the same account. No sample data.
 *
 * ADR-035 D1b — capture is DURABLE here, not held in a React ref. Every chunk is
 * written to OPFS (or IndexedDB) as it arrives, so a tab that crashes, reloads or
 * is closed mid-meeting comes back with the audio it had recorded, and the
 * session is offered back on the next load. The store is `lib/meetings/`; this
 * page only drives the recorder, watches the budget it reports, and renders the
 * recovery offer. Nothing here defers work to an unload handler — a closing tab
 * gets very little time, so nothing important may depend on it running.
 *
 * ADR-035 D3/D4/D5 — and the audio becomes TEXT as it lands, not at Stop. Each
 * chunk is a segment; the shared `MeetingTranscriptionQueue` transcribes them
 * with bounded concurrency, the compose box fills in during the meeting, and a
 * segment that will not transcribe stays in the transcript as a gap with its
 * time range and a retry control. The scheduler, the retry rule and the session
 * model all come from `@kinqs/brainrouter-core/meetings` — D1b: only the write
 * target is host-specific — so nothing here restates a policy the desktop also
 * has to obey.
 *
 * The honest boundary, per open question 3: a renderer-owned queue dies with the
 * window, and a browser tab has no host process to hand it to. The browser's
 * answer is that the queue holds nothing worth surviving — it recomputes its work
 * from the persisted session every pass — so a killed tab loses a scheduler and
 * not a position, and the next load rebuilds one over the same record.
 *
 * Two things this page must do that are easy to leave out. Stop DRAINS the
 * store's write queue before it settles the session, because `onstop` fires while
 * the final chunk is still being written. And every load REAPS captures whose
 * session record is gone, because the browser's quota is finite and audio nothing
 * can offer back is audio nothing can free.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Lock, UsersThree, Buildings, GlobeHemisphereWest, Microphone, type Icon } from "@phosphor-icons/react";
import {
  appendSegment,
  createCaptureSession,
  discardCapture as discardCaptureSession,
  finalizeCapture,
  stopCapture,
  summarizeRecovery,
  type MeetingCaptureSession,
  type MeetingCaptureTemplate,
  type MeetingDrainPhase,
  type MeetingTranscriptionQueue,
} from "@kinqs/brainrouter-core/meetings";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { InlineLoading } from "../../components/LoadingSpinner";
import { adminApi, authFetch, type Team } from "../../lib/adminApi";
import { useActiveOrg } from "../../components/OrgWorkspaceProvider";
import { BASE_URL } from "../../lib/client";
import { getApiKey, getJwt } from "../../lib/client-auth";
import { invalidateDashboardQueries, queryDashboard } from "../../lib/dashboardQuery";
import { parseCapturePayload, restoreCaptureSession } from "../../lib/meetings/capturePayload";
import { createCaptureQueue, createSttTranscriber, DEFAULT_CAPTURE_MIME_TYPE } from "../../lib/meetings/captureQueue";
import { newCaptureSessionId } from "../../lib/meetings/captureStorage";
import { MEETING_CAPTURE_TIMESLICE_MS, type CaptureSessionRecord, type MeetingCaptureStore } from "../../lib/meetings/captureStore";
import { captureFallbackNotice, openMeetingCaptureStore, type OpenedCaptureStore } from "../../lib/meetings/openCaptureStore";
import { formatCaptureBytes, isStorageQuotaError } from "../../lib/meetings/storageBudget";
import {
  appendTranscriptSync,
  beginTranscriptSync,
  nextTranscriptSync,
  transcriptRevisionPending,
  type TranscriptSyncState,
} from "../../lib/meetings/transcriptSync";
import { LiveTranscript } from "./LiveTranscript";
import styles from "./meetings.module.css";

type Scope = "private" | "team" | "org" | "public";
type SummaryStatus = "queued" | "processing" | "ready" | "failed";
interface ListItem { id: string; title: string; date: string; scope: Scope; attendeeCount: number; summaryStatus: SummaryStatus; originOrgId: string; canEdit: boolean }
interface ActionItem { id: string; title: string; assignee?: string; done?: boolean; trackItemId?: string }
interface Share { scope: Scope; teamId?: string; publicUrl?: string; expiresAt?: string }
interface Detail {
  id: string; title: string; date: string; status: string; durationMin?: number; wordCount?: number;
  originOrgId: string; canEdit: boolean;
  attendees: string[]; model?: { label: string; effort?: string };
  summaryMarkdown: string; actionItems: ActionItem[];
  transcript: { at: string; speaker: string; text: string }[];
  share: Share;
  summaryStatus: SummaryStatus; summaryError?: string;
}
type Overview = Omit<Detail, "transcript">;
interface TranscriptPage { segments: Array<{ ordinal: number; at: string; speaker: string; text: string }>; total: number; nextCursor: string | null }

/**
 * ADR-035 D1b — the recording in progress. `bytes` and `startedMs` are here and
 * not in React state on purpose: they feed the storage-budget projection on every
 * chunk, and a re-render per 20-second chunk is not a reason to re-render a page
 * showing a meeting library.
 */
interface ActiveCapture {
  readonly store: MeetingCaptureStore;
  readonly sessionId: string;
  readonly startedMs: number;
  readonly mimeType: string;
  bytes: number;
  /**
   * When the previous chunk landed. A segment's duration is measured rather than
   * assumed to be the timeslice: `MediaRecorder` pauses, the tab is backgrounded,
   * and the last chunk of a meeting is always short — and these numbers are what
   * D5 prints in a gap marker, so a guessed one misreports where the hole is.
   */
  lastChunkMs: number;
}

/**
 * ADR-035 D6 — a meeting that was created but whose audio could not be released.
 *
 * Kept as its own list, and rendered outside the compose dialog, because the
 * failure happens in the same commit that closes it: the meeting succeeded, the
 * bytes are still here, and a message inside a form that is about to unmount can
 * never be read. It is also the only way back to that audio — the record is
 * already marked closed, so `resumable` will not offer it and the reap will
 * claim it on the next pass rather than leaving it for a user to find.
 */
interface RetainedAudio {
  readonly sessionId: string;
  readonly message: string;
}

/**
 * §6 — "the audio up to the kill must be on disk AND PLAYABLE".
 *
 * A recovered meeting whose transcript comes back but whose recording can never
 * be heard satisfies half of the destructive test. `url` is an object URL over
 * what the store reassembled, so it is revoked on the way out; `missing` is how
 * many chunks the store could not read, because a player that silently skips
 * them is the "quietly wrong" failure D5 rules out one layer up.
 */
interface CapturePreview {
  readonly sessionId: string;
  readonly url: string;
  readonly missing: number;
}

/** An error's own words when it has any, and a plain sentence when it does not. */
function describe(caught: unknown, fallback: string): string {
  const message = caught instanceof Error ? caught.message.trim() : "";
  return message || fallback;
}

/**
 * Whether a refused chunk write means the store is full — the one write failure
 * that is terminal and must stop the recorder.
 *
 * Asked two ways because browsers disagree about how they say it: the error's
 * own shape first, then the budget, since "the write failed and there is no room
 * left" is the same fact arrived at from the other side. Anything else is
 * treated as transient — the store leaves the sequence free and the next chunk
 * fills it, so one bad write must not end a meeting.
 */
async function captureIsFull(capture: ActiveCapture, caught: unknown): Promise<boolean> {
  if (isStorageQuotaError(caught)) return true;
  try {
    const budget = await capture.store.budget({ byteLength: capture.bytes, recordedMs: Date.now() - capture.startedMs });
    return budget.level === "exhausted";
  } catch {
    // A budget we cannot read is not evidence of a full store, and stopping a
    // recording on a guess is its own kind of loss.
    return false;
  }
}

/**
 * The opening of the reap's own warning, so a later success can retract exactly
 * that sentence and nothing else in the same slot.
 */
const REAP_WARNING = "Recordings this device can no longer account for were not cleaned up — ";

const SCOPE_META: Record<Scope, { label: string; blurb: string; badge: string; dot: string; Icon: Icon }> = {
  private: { label: "Private", blurb: "Only you can see this meeting.", badge: styles.bPrivate, dot: "", Icon: Lock },
  team: { label: "Team", blurb: "Members of your team can recall it.", badge: styles.bTeam, dot: styles.dotTeam, Icon: UsersThree },
  org: { label: "Organization", blurb: "Everyone in your organization.", badge: styles.bOrg, dot: styles.dotOrg, Icon: Buildings },
  public: { label: "Public", blurb: "Anyone with the link — redacted summary only.", badge: styles.bPublic, dot: styles.dotPublic, Icon: GlobeHemisphereWest },
};
const SCOPES: Scope[] = ["private", "team", "org", "public"];

const CAPTURE_TEMPLATES: readonly MeetingCaptureTemplate[] = ["general", "standup", "one-on-one", "retrospective"];

/**
 * The picker's value as the shared model's template.
 *
 * The two vocabularies are deliberately the same list, so this is a narrowing
 * rather than a mapping — but it is a narrowing that has to exist, because a
 * select's value is a string and `createCaptureSession` would take a
 * meaningless one silently.
 */
function captureTemplate(value: string): MeetingCaptureTemplate {
  return CAPTURE_TEMPLATES.find((template) => template === value) ?? "general";
}

function ScopeBadge({ scope }: { scope: Scope }) {
  const m = SCOPE_META[scope];
  return <span className={`${styles.badge} ${m.badge}`}>{scope === "org" ? "Org" : m.label}</span>;
}

function TranscriptLines({ segments }: { segments: Detail["transcript"] }) {
  const [scrollTop, setScrollTop] = useState(0);
  const rowHeight = 58;
  const viewportHeight = 520;
  const overscan = 5;
  if (segments.length <= 40) return <>{segments.map((line, index) => <TranscriptLine key={index} line={line} />)}</>;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const end = Math.min(segments.length, start + visible);
  return (
    <div className={styles.transcriptViewport} style={{ height: viewportHeight }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} role="list" aria-label={`${segments.length} loaded transcript segments`}>
      <div style={{ height: segments.length * rowHeight, position: "relative" }}>
        <div style={{ position: "absolute", top: start * rowHeight, right: 0, left: 0 }}>
          {segments.slice(start, end).map((line, offset) => <TranscriptLine key={start + offset} line={line} />)}
        </div>
      </div>
    </div>
  );
}

function TranscriptLine({ line }: { line: Detail["transcript"][number] }) {
  return <div className={styles.trLine} role="listitem">{line.at ? <span className={styles.trTs}>{line.at}</span> : null}{line.speaker ? <span className={styles.trSp}>{line.speaker}</span> : null}<span className={styles.trTx}>{line.text}</span></div>;
}

export default function MeetingsPage() {
  const [items, setItems] = useState<ListItem[]>([]);
  const [meetingsNext, setMeetingsNext] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [transcriptSegments, setTranscriptSegments] = useState<Detail["transcript"]>([]);
  const [transcriptNext, setTranscriptNext] = useState<string | null>(null);
  const [transcriptTotal, setTranscriptTotal] = useState(0);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  // ADR-019 Phase 2 — the org context comes from the app-wide workspace switcher
  // (top of the sidebar), not a per-page picker. Every meetings call sends the
  // active org id as the X-BrainRouter-Org header.
  const { activeOrg, activeOrgId } = useActiveOrg();
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTranscript, setDraftTranscript] = useState("");
  const [createErr, setCreateErr] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [language, setLanguage] = useState("auto");
  const [summaryTemplate, setSummaryTemplate] = useState("general");
  const [editing, setEditing] = useState(false);
  const [draftSummary, setDraftSummary] = useState("");
  const [meetingQuery, setMeetingQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<Scope | "all">("all");
  const [draftRecovered, setDraftRecovered] = useState(false);
  const [copied, setCopied] = useState(false);
  // ADR-035 D1b — what the durable store has to say about itself: which store it
  // is, and how much room is left. Rewritten on every chunk, so it is only ever
  // the CURRENT advisory and is routinely blank.
  const [captureNotice, setCaptureNotice] = useState("");
  // …and, separately, what has gone WRONG. These were one slot, and because the
  // budget writes to it every twenty seconds, every warning that mattered — a
  // persist that failed, a manifest that could not be written, a store that
  // filled up — was erased by the next timeslice while it was still true. Two
  // slots because they have different lifetimes: the advisory is a reading, this
  // is an event, and an event has to survive until it stops being the case.
  const [captureWarning, setCaptureWarning] = useState("");
  const [recoverable, setRecoverable] = useState<readonly CaptureSessionRecord[]>([]);
  // ADR-028 — a recovery query that FAILED is not "nothing to recover". Both
  // render as a page with no offer on it, and only one of them means the audio
  // is gone, so a failure says so instead. The desktop has had this since it
  // learned the same lesson (`MeetingsView`); D1b says the browser is not
  // allowed to be the lesser host.
  const [recoveryError, setRecoveryError] = useState("");
  const [retainedAudio, setRetainedAudio] = useState<readonly RetainedAudio[]>([]);
  const [preview, setPreview] = useState<CapturePreview | null>(null);
  // ADR-035 D4 — the transcript as the shared model currently holds it, and why
  // the queue last stopped. Both are rendered rather than inferred: ADR-028 asks
  // the surface to say which state it is actually in.
  const [captureSession, setCaptureSession] = useState<MeetingCaptureSession | null>(null);
  const [capturePhase, setCapturePhase] = useState<MeetingDrainPhase | null>(null);
  const [retryingSegment, setRetryingSegment] = useState<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const captureRef = useRef<ActiveCapture | null>(null);
  // The shared scheduler for the capture in hand. One per meeting, and the
  // SINGLE WRITER of its session while it exists — every transition goes through
  // `queue.apply`, never beside it.
  const queueRef = useRef<MeetingTranscriptionQueue | null>(null);
  /** Pending `setTimeout` for the next drain, so a re-render cannot stack two. */
  const wakeRef = useRef<number | null>(null);
  const syncRef = useRef<TranscriptSyncState>(beginTranscriptSync(""));
  // The object URL behind the player, mirrored in a ref so it can be revoked
  // from an unmount cleanup without the state value going stale in the closure.
  const previewRef = useRef<{ sessionId: string; url: string } | null>(null);
  // The WHOLE opened store, not just `{ store, persisted }`: `kind` and
  // `rejected` are what tell a user their audio went to the IndexedDB fallback
  // instead of OPFS, and a fallback nobody can see is a silent outage.
  const captureStoreRef = useRef<OpenedCaptureStore | null>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("brainrouter:meeting-draft") ?? "null") as { title?: string; transcript?: string; language?: string; template?: string } | null;
      if (saved?.title) setDraftTitle(saved.title);
      if (saved?.transcript) setDraftTranscript(saved.transcript);
      if (saved?.language) setLanguage(saved.language);
      if (saved?.template) setSummaryTemplate(saved.template);
      if (saved?.title || saved?.transcript) setDraftRecovered(true);
    } catch { /* a malformed local draft should not block Meetings */ }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (draftTitle || draftTranscript) localStorage.setItem("brainrouter:meeting-draft", JSON.stringify({ title: draftTitle, transcript: draftTranscript, language, template: summaryTemplate }));
      else localStorage.removeItem("brainrouter:meeting-draft");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draftTitle, draftTranscript, language, summaryTemplate]);

  // Poll while notes are generating — the server keeps summarizing across refreshes,
  // so this converges the status without the user re-triggering anything.
  useEffect(() => {
    if (!detail || (detail.summaryStatus !== "processing" && detail.summaryStatus !== "queued")) return;
    const id = detail.id;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const overview = await authFetch<Overview>(`/api/meetings/${id}/overview`, { orgId: activeOrgId || undefined });
        if (!alive) return;
        setDetail((cur) => (cur && cur.id === id ? { ...cur, ...overview } : cur));
        setItems((list) => list.map((m) => (m.id === id ? { ...m, summaryStatus: overview.summaryStatus } : m)));
      } catch { /* transient — keep polling */ }
    }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [detail?.id, detail?.summaryStatus, activeOrgId]);

  const saveSummary = useCallback(async () => {
    if (!detail) return;
    setBusy("save-summary");
    try {
      const d = await authFetch<Detail>(`/api/meetings/${detail.id}/summary`, { method: "PATCH", body: { summaryMarkdown: draftSummary }, orgId: activeOrgId || undefined });
      invalidateDashboardQueries(`meetings:overview:${activeOrgId || "default"}:${detail.id}`);
      setDetail(d);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the summary.");
    } finally {
      setBusy("");
    }
  }, [detail, draftSummary, activeOrgId]);

  /**
   * ADR-035 D8 — the IMPORT path, and only that one.
   *
   * A user handing us a file really can hand us an hour of audio in one piece,
   * so the endpoint's body limit is a real ceiling here and refusing early is
   * kinder than a 413 after a long upload. Recorded captures no longer come
   * through here at all: D3 removed that ceiling by never assembling the
   * meeting, so a recording posts twenty seconds at a time and this check would
   * only ever be able to be wrong about it.
   *
   * Resolves true only when speech actually became text — the caller decides
   * what to keep.
   */
  const transcribe = useCallback(async (blob: Blob): Promise<boolean> => {
    setBusy("transcribe");
    setCreateErr("");
    try {
      if (!blob.size) throw new Error("The selected audio file is empty.");
      if (blob.size > 40 * 1024 * 1024) throw new Error("Audio must be 40 MB or smaller.");
      const token = getJwt() || getApiKey() || "";
      const res = await fetch(`${BASE_URL}/v1/audio/transcriptions${language === "auto" ? "" : `?language=${encodeURIComponent(language)}`}`, {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: blob,
      });
      if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
      const out = (await res.json()) as { text?: string };
      const text = (out.text ?? "").trim();
      if (text) { setDraftTranscript((cur) => (cur ? `${cur}\n${text}` : text)); return true; }
      setCreateErr("No speech was detected in the recording.");
      return false;
    } catch (caught) {
      setCreateErr(caught instanceof Error ? caught.message : "Transcription failed.");
      return false;
    } finally {
      setBusy("");
    }
  }, [language]);

  // One store per page, opened lazily. `requestPersistence` is false everywhere
  // except Record: opening it to look for a recovered meeting must not put a
  // storage-permission prompt in front of someone browsing their library.
  const captureStore = useCallback(async (requestPersistence: boolean): Promise<MeetingCaptureStore> => {
    const cached = captureStoreRef.current;
    const opened = cached && (!requestPersistence || cached.persisted)
      ? cached
      : await openMeetingCaptureStore({ requestPersistence });
    captureStoreRef.current = opened;
    // Read the budget on EVERY Record, including the one that reused an
    // already-open store. Tying the notice to the open meant the second
    // recording of a session heard nothing until the first chunk landed twenty
    // seconds in — which is after the moment the warning exists for.
    if (requestPersistence) {
      const notice = [captureFallbackNotice(opened), (await opened.store.budget()).message]
        .filter(Boolean)
        .join(" ");
      setCaptureNotice(notice);
    }
    return opened.store;
  }, []);

  const cancelWake = useCallback(() => {
    if (wakeRef.current === null) return;
    window.clearTimeout(wakeRef.current);
    wakeRef.current = null;
  }, []);

  /**
   * ADR-035 D3/D5/D7 — run the shared queue once, then come back when it says to.
   *
   * Everything about WHICH segments run, how many at a time and when a retry is
   * due lives in the queue; this only turns its answer into a re-render and a
   * timer. `nextWakeMs` is the queue's own schedule — during an outage it is the
   * backoff it wants to be probed on, so honouring it is what stops a page timer
   * hammering a sidecar that is already struggling.
   */
  const runDrainRef = useRef<(force?: number) => Promise<void>>(async () => {});
  const runDrain = useCallback(async (force?: number) => {
    const queue = queueRef.current;
    if (!queue) return;
    cancelWake();
    try {
      const result = force === undefined ? await queue.drain() : await queue.retry(force);
      // A newer capture replaced this one while the drain was in flight; its
      // session is the truth now, and painting this one would show a meeting the
      // user has already moved on from.
      if (queueRef.current !== queue) return;
      setCaptureSession(result.session);
      setCapturePhase(result.phase);
      // A persist that threw is a host about to lose the record of a meeting
      // whose audio is fine. Worth saying out loud rather than swallowing — and
      // in the slot the next chunk's budget reading will not overwrite.
      if (result.errors.length) {
        setCaptureWarning(`This recording's progress could not be saved on this device: ${result.errors[0]}`);
      }
      if (result.nextWakeMs !== null) {
        // Floored, so a queue asking to be woken "now" cannot become a spin.
        wakeRef.current = window.setTimeout(() => {
          wakeRef.current = null;
          void runDrainRef.current();
        }, Math.max(500, result.nextWakeMs));
      }
    } catch (caught) {
      setCreateErr(caught instanceof Error ? caught.message : "Transcription could not be scheduled.");
    }
  }, [cancelWake]);
  useEffect(() => { runDrainRef.current = runDrain; }, [runDrain]);

  /**
   * Install a queue over one stored capture and start draining it.
   *
   * The transcriber is built here rather than inside the queue because the token
   * and the language are page state; the queue only knows "audio in, text out".
   */
  const attachQueue = useCallback((
    store: MeetingCaptureStore,
    session: MeetingCaptureSession,
    options: { readonly mimeType?: string; readonly title?: string; readonly base: string },
  ): MeetingTranscriptionQueue => {
    cancelWake();
    const queue = createCaptureQueue({
      store,
      session,
      mimeType: options.mimeType ?? DEFAULT_CAPTURE_MIME_TYPE,
      ...(options.title ? { title: options.title } : {}),
      transcribe: createSttTranscriber({
        baseUrl: BASE_URL,
        token: getJwt() || getApiKey() || "",
        ...(language === "auto" ? {} : { language }),
      }),
    });
    queueRef.current = queue;
    syncRef.current = beginTranscriptSync(options.base);
    setCaptureSession(session);
    setCapturePhase(null);
    setRetryingSegment(null);
    return queue;
  }, [cancelWake, language]);

  /** Put the object URL back, and forget the recording it was playing. */
  const revokePreview = useCallback(() => {
    if (!previewRef.current) return;
    URL.revokeObjectURL(previewRef.current.url);
    previewRef.current = null;
    setPreview(null);
  }, []);

  /**
   * D6 — the audio survived a delete that did not, and the user is told where it
   * is rather than left with a meeting whose recording quietly persists.
   */
  const retainAudio = useCallback((sessionId: string, caught: unknown) => {
    const detail = describe(caught, "the capture store refused the delete.");
    setRetainedAudio((rows) => [
      ...rows.filter((row) => row.sessionId !== sessionId),
      { sessionId, message: `A recording's audio is still saved on this device — ${detail}` },
    ]);
  }, []);

  /**
   * D6 — the audio is released, and the record says why it is gone.
   *
   * The session transition goes through the queue (the single writer) so the
   * manifest is marked closed BEFORE the delete: a kill between the two leaves a
   * closed session that `resumable` will not offer back, which is the right way
   * round. The reverse would offer back a meeting whose audio no longer exists.
   */
  const releaseCapture = useCallback(async (accepted: boolean) => {
    const queue = queueRef.current;
    if (!queue) return;
    queueRef.current = null;
    cancelWake();
    const sessionId = queue.session.id;
    revokePreview();
    try {
      await queue.apply((session) => (accepted ? finalizeCapture(session) : discardCaptureSession(session)));
      // Then WAIT for the queue, the way the desktop's supervisor waits for its
      // drains before finalizing. A segment already in flight persists the whole
      // session when it lands, and a persist that lands after the delete is a
      // manifest written back over a session that no longer exists. This is
      // bounded and cannot become a hang: the transition above is terminal, so
      // the plan is `closed` and no NEW segment is dispatched — all this waits
      // for is the at-most-two requests already outstanding.
      await queue.drain();
      const store = await captureStore(false);
      await store.delete(sessionId);
    } catch (caught) {
      // NOT `setCreateErr`: every caller of this closes the dialog on the next
      // line, and `createErr` renders only inside it — so the one sentence that
      // says the audio is still here could never be read, and reopening the
      // dialog cleared it first. It goes to a list the page renders instead,
      // with the control that finishes the job.
      retainAudio(sessionId, caught);
    } finally {
      setCaptureSession(null);
      setCapturePhase(null);
      setRetryingSegment(null);
    }
  }, [cancelWake, captureStore, retainAudio, revokePreview]);

  /** The retry for a delete that failed — D6's "deletion is a real deletion", asked again. */
  const releaseRetained = useCallback(async (sessionId: string) => {
    try {
      const store = await captureStore(false);
      await store.delete(sessionId);
      setRetainedAudio((rows) => rows.filter((row) => row.sessionId !== sessionId));
    } catch (caught) {
      retainAudio(sessionId, caught);
    }
  }, [captureStore, retainAudio]);

  // ADR-035 D2 — on load, a session with audio and no terminal state is offered
  // back. This is the whole recovery path: nothing was written at unload, so
  // there is nothing to reconstruct.
  //
  // D6 rides along: audio whose manifest is gone can never be offered back, so
  // it would sit in the origin's quota until the browser evicted the whole site.
  // The desktop reaps at boot (`registerMeetingCaptureBridge`); the browser must
  // too, or the fallback everything here depends on runs out of room.
  const refreshRecoverable = useCallback(async () => {
    // The recording happening right now is unfinished by definition; offering it
    // back while the microphone is still open would be nonsense — and reaping it
    // would be worse, so it is also the one id the store cannot judge alone.
    const active = captureRef.current?.sessionId ?? queueRef.current?.session.id;
    let store: MeetingCaptureStore;
    try {
      store = await captureStore(false);
    } catch (caught) {
      // No durable store here, or none we could open. This is NOT "there is
      // nothing to recover": audio already written is still written, and saying
      // so is the difference between a user waiting and a user giving up.
      setRecoveryError(`Recordings saved on this device could not be checked — ${describe(caught, "this browser would not open its durable store.")}`);
      return;
    }
    // D6 — the reap gets its own try. It is housekeeping, and a failed tidy-up
    // must not be reported as an empty device: the offer below is this ADR's
    // deliverable and does not depend on it.
    try {
      const reaped = await store.reapOrphans(active ? { keep: [active] } : {});
      // D6 asks for the reap to be logged: audio no session claims is exactly
      // the artifact nobody would otherwise notice.
      if (reaped.length) console.warn(`[meetings] reaped ${reaped.length} capture(s) no session claims.`);
      // A reap that has now succeeded means the previous failure has stopped
      // being true, and a warning that outlives its cause is the same dishonesty
      // as one that is erased too early. Matched on its own text rather than
      // cleared outright, because this slot also carries warnings — a failed
      // persist, a store that filled up — that this says nothing about.
      setCaptureWarning((current) => (current.startsWith(REAP_WARNING) ? "" : current));
    } catch (caught) {
      console.warn("[meetings] the capture reap could not run.", caught);
      setCaptureWarning(`${REAP_WARNING}${describe(caught, "the capture store refused the delete.")} They are still using storage.`);
    }
    try {
      // `resumable` rather than a filter here: which sessions come back is the
      // store's rule, and restating it is how the two halves drift apart.
      setRecoverable((await store.resumable()).filter((record) => record.sessionId !== active));
      setRecoveryError("");
    } catch (caught) {
      setRecoveryError(`Recordings saved on this device could not be checked — ${describe(caught, "the capture store did not answer.")} Any audio already written is still there.`);
    }
  }, [captureStore]);

  useEffect(() => { void refreshRecoverable(); }, [refreshRecoverable]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
    setRecordingPaused(false);
  }, []);

  /**
   * ADR-035 D1/D3 — the chunk becomes bytes before it becomes anything else,
   * then a segment, then work for the queue. The budget is re-read from what has
   * actually been written.
   *
   * The order is the whole point: `appendChunk` resolves only once the backend
   * reports the write complete, so the segment record is never a claim about
   * audio that does not exist. `MeetingSegment.byteLength` is "what the host
   * actually wrote", and recovery believes it.
   */
  const persistChunk = useCallback(async (capture: ActiveCapture, data: Blob) => {
    try {
      const chunk = await capture.store.appendChunk(capture.sessionId, data);
      capture.bytes += chunk.byteLength;
      const landedMs = Date.now();
      const durationMs = Math.max(1, landedMs - capture.lastChunkMs);
      capture.lastChunkMs = landedMs;
      const queue = queueRef.current;
      if (queue && queue.session.id === capture.sessionId) {
        // The index/sequence check is INSIDE the transition because `apply` is
        // serialized: reading the length outside it would race a concurrent
        // append. The queue's `readSegment(index)` port reads chunk `index`, so a
        // segment recorded at the wrong index would transcribe somebody else's
        // audio into plausible-looking text. An unclaimed chunk is the safe
        // failure — `restoreCaptureSession` adopts it on the next load.
        await queue.apply((session) => (
          // The status guard is belt-and-braces: `MediaRecorder` delivers its
          // last chunk before `onstop`, so a chunk should never arrive after the
          // capture was settled. If one somehow does, leaving it unclaimed is
          // recoverable (the next load adopts it) and throwing here would report
          // a lost recording that is not lost.
          session.status === "recording" && session.segments.length === chunk.sequence
            ? appendSegment(session, { byteLength: chunk.byteLength, durationMs })
            : session
        ));
        setCaptureSession(queue.session);
        void runDrain();
      }
      const budget = await capture.store.budget({
        byteLength: capture.bytes,
        recordedMs: Date.now() - capture.startedMs,
      });
      setCaptureNotice(budget.message);
      // Out of space: stop while everything recorded so far is still readable.
      // Continuing would keep failing writes and lose exactly the audio the user
      // thinks is being captured.
      if (budget.level === "exhausted") stopRecording();
    } catch (caught) {
      setCreateErr(caught instanceof Error ? caught.message : "A piece of this recording could not be saved.");
      // The success path's `exhausted` guard never runs when the WRITE is what
      // failed — which is precisely when the store is full. Without this the
      // surface keeps offering "■ Stop recording" while every remaining chunk
      // is refused: the silent loss this ADR exists to end, with a button on it.
      if (await captureIsFull(capture, caught)) {
        setCaptureWarning("Storage for this site is full. Recording stopped so the audio already saved stays intact.");
        stopRecording();
      }
    }
  }, [stopRecording, runDrain]);

  /**
   * Stop pressed (or the store filled up): settle the capture and let the queue
   * finish.
   *
   * Nothing is read back in one piece and nothing is deleted here. Under D3 the
   * segments have been transcribing all along, and under D7 the ones that have
   * not can keep draining after Stop — so the audio stays on the device until
   * the user accepts the meeting or discards it (D6).
   */
  const finishCapture = useCallback(async (capture: ActiveCapture) => {
    captureRef.current = null;
    try {
      // The final chunk arrives at `ondataavailable` and `onstop` fires straight
      // after it, so at this instant the last twenty seconds of the meeting are
      // still being written. Draining the store's queue first is what stops the
      // meeting being settled without its ending.
      await capture.store.settled(capture.sessionId);
      const queue = queueRef.current;
      if (!queue || queue.session.id !== capture.sessionId) return;
      // Ordered after the final chunk's own `apply` by the queue's write chain,
      // so `stopCapture` cannot land before the segment it belongs with.
      await queue.apply((session) => (session.status === "recording" ? stopCapture(session) : session));
      setCaptureSession(queue.session);
      if (!queue.session.segments.length) {
        setCreateErr("No audio was captured — check that the right microphone is selected.");
        await releaseCapture(false);
        return;
      }
      await runDrain();
    } catch (caught) {
      setCreateErr(caught instanceof Error ? caught.message : "The recording could not be settled.");
    } finally {
      await refreshRecoverable();
    }
  }, [runDrain, releaseCapture, refreshRecoverable]);

  const startRecording = useCallback(async () => {
    setCreateErr("");
    // A new recording is the one moment the last one's warnings stop being true.
    setCaptureWarning("");
    const title = draftTitle.trim();
    let store: MeetingCaptureStore;
    let sessionId: string;
    try {
      store = await captureStore(true);
      sessionId = newCaptureSessionId();
      // D2 — the session exists from the moment Record is pressed, so a crash
      // has somewhere to be found again.
      await store.begin({ sessionId });
    } catch (caught) {
      setCreateErr(caught instanceof Error ? caught.message : "This browser cannot store a recording durably.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const startedMs = Date.now();
      const capture: ActiveCapture = {
        store,
        sessionId,
        startedMs,
        lastChunkMs: startedMs,
        mimeType: rec.mimeType || DEFAULT_CAPTURE_MIME_TYPE,
        bytes: 0,
      };
      captureRef.current = capture;
      // Open question 5 — the org is frozen here, at Record. Nothing rewrites a
      // session's scope afterwards, so a recording that started under one
      // organization cannot silently land in another when the switcher moves.
      const queue = attachQueue(store, createCaptureSession({
        id: sessionId,
        startedAt: new Date(startedMs).toISOString(),
        scope: { orgId: activeOrgId || null },
        title,
        template: captureTemplate(summaryTemplate),
        ...(language === "auto" ? {} : { language }),
      }), { mimeType: capture.mimeType, title, base: draftTranscript });
      // Awaited, and before the first chunk: this is the write that puts the
      // session and the recorder's container type in the manifest, and recovery
      // reads the audio back with them. Fire-and-forget meant a failed write left
      // a recovered meeting to default to WebM — silently wrong on a browser that
      // records MP4, which is a transcription that fails for a reason nobody can
      // see. It goes through `apply` because the queue is the single writer.
      try {
        await queue.apply((session) => session);
      } catch (caught) {
        // The audio itself is unaffected, so this warns rather than refuses: a
        // recording with an unrecorded format beats no recording.
        setCaptureWarning(`This recording's details could not be saved (${describe(caught, "unknown error")}). If it has to be recovered later it will be read back as WebM.`);
      }
      rec.ondataavailable = (e) => { if (e.data.size) void persistChunk(capture, e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void finishCapture(capture);
      };
      recorderRef.current = rec;
      // D1 — an explicit timeslice. Without one MediaRecorder may hand over a
      // single blob at the end, and writing it down then buys nothing. D3 makes
      // the same number the segment length: one chunk is one unit of transcription.
      rec.start(MEETING_CAPTURE_TIMESLICE_MS);
      setRecording(true);
      setRecordingPaused(false);
    } catch {
      // Only tear down the queue if it is THIS recording's. `getUserMedia` can
      // reject before one was ever attached, and clearing unconditionally would
      // drop a previous capture that is still legitimately draining.
      if (queueRef.current?.session.id === sessionId) {
        queueRef.current = null;
        setCaptureSession(null);
      }
      void store.delete(sessionId).catch(() => {});
      setCreateErr("Microphone access was denied or is unavailable.");
    }
  }, [attachQueue, activeOrgId, captureStore, draftTitle, draftTranscript, finishCapture, language, persistChunk, summaryTemplate]);

  /**
   * D2/D3 — pick a crashed recording back up, and carry on transcribing it.
   *
   * This is the reload half of the honest boundary in the module header: the
   * queue did not survive the tab, so one is rebuilt over the persisted session
   * and asked what is left to do. It posts nothing whole — the segments that
   * already transcribed stay transcribed, and only the unfinished ones run.
   */
  const pickUpCapture = useCallback(async (record: CaptureSessionRecord) => {
    setCreateOpen(true);
    setCaptureNotice("");
    setCaptureWarning("");
    setCreateErr("");
    try {
      const store = await captureStore(false);
      const { title, mimeType } = parseCapturePayload(record.payload);
      const session = restoreCaptureSession({ record, scope: { orgId: activeOrgId || null } });
      if (title) setDraftTitle((cur) => cur || title);
      attachQueue(store, session, {
        ...(mimeType ? { mimeType } : {}),
        ...(title ? { title } : {}),
        base: draftTranscript,
      });
      await runDrain();
    } catch (caught) {
      setCreateErr(caught instanceof Error ? caught.message : "The saved recording could not be read.");
    } finally {
      await refreshRecoverable();
    }
  }, [activeOrgId, attachQueue, captureStore, draftTranscript, refreshRecoverable, runDrain]);

  const discardCapture = useCallback(async (record: CaptureSessionRecord) => {
    if (!window.confirm("Discard this unfinished recording? Its audio is deleted from this device.")) return;
    // The player is reading the bytes this is about to delete.
    if (previewRef.current?.sessionId === record.sessionId) revokePreview();
    try {
      // A capture that is currently in hand is discarded THROUGH the queue, so
      // the record says it was thrown away rather than merely vanishing.
      if (queueRef.current?.session.id === record.sessionId) {
        await releaseCapture(false);
        return;
      }
      const store = await captureStore(false);
      await store.delete(record.sessionId);
    } catch (caught) {
      setCreateErr(describe(caught, "The recording could not be deleted."));
    } finally {
      await refreshRecoverable();
    }
  }, [captureStore, refreshRecoverable, releaseCapture, revokePreview]);

  /**
   * §6 — hear the recording that came back.
   *
   * The destructive test asks for the audio to be "on disk and playable", and
   * `readAudio` has been the store's answer to it with nothing calling it: a
   * user who ran the test got the session and the transcript back and could
   * never hear a second of what they recorded. Reassembling the whole capture is
   * the one place that is the right thing to do — the transcription path
   * deliberately never does it (D3), but a person listening needs the meeting,
   * not a segment.
   */
  const previewCapture = useCallback(async (record: CaptureSessionRecord) => {
    if (previewRef.current?.sessionId === record.sessionId) {
      revokePreview();
      return;
    }
    setBusy("preview");
    try {
      const store = await captureStore(false);
      const { mimeType } = parseCapturePayload(record.payload);
      const audio = await store.readAudio(record.sessionId, mimeType || DEFAULT_CAPTURE_MIME_TYPE);
      revokePreview();
      const url = URL.createObjectURL(audio.blob);
      previewRef.current = { sessionId: record.sessionId, url };
      setPreview({ sessionId: record.sessionId, url, missing: audio.missing.length });
    } catch (caught) {
      setCreateErr(describe(caught, "This recording could not be read back from this device."));
    } finally {
      setBusy("");
    }
  }, [captureStore, revokePreview]);

  /** D5 — a person can see this gap and is asking for it again, bound or no bound. */
  const retrySegment = useCallback(async (index: number) => {
    setRetryingSegment(index);
    try {
      await runDrain(index);
    } finally {
      setRetryingSegment(null);
    }
  }, [runDrain]);

  // D4 — the compose box follows the live transcript until the moment a person
  // types in it, and never afterwards. `nextTranscriptSync` owns that rule; this
  // only applies its answer.
  useEffect(() => {
    if (!captureSession) return;
    const next = nextTranscriptSync(syncRef.current, captureSession, draftTranscript);
    syncRef.current = next.state;
    if (next.text !== undefined) setDraftTranscript(next.text);
  }, [captureSession, draftTranscript]);

  // Whether the transcript has moved on from what the user's edited box holds.
  // Recomputed every render rather than memoized: it reads a ref, so a
  // dependency array could only ever be a lie about what it depends on, and the
  // work is a pass over a list that is already in memory.
  const captureRevisionPending = captureSession !== null
    && transcriptRevisionPending(syncRef.current, captureSession, draftTranscript);

  const appendCaptureText = useCallback(() => {
    if (!captureSession) return;
    const next = appendTranscriptSync(syncRef.current, captureSession, draftTranscript);
    syncRef.current = next.state;
    setDraftTranscript(next.text);
  }, [captureSession, draftTranscript]);

  // Nothing durable depends on either of these running — the audio and the
  // session are already written. One stops a timer firing into an unmounted
  // page; the other hands back the memory the player was holding.
  useEffect(() => cancelWake, [cancelWake]);
  useEffect(() => revokePreview, [revokePreview]);
  // The player is rendered inside the compose dialog and nowhere else, so a
  // closed dialog leaves an object URL over a WHOLE meeting's audio that nothing
  // can show and nothing will revoke — an hour of WebM pinned in the tab's heap,
  // which is the exact thing D1 stopped doing on the write side.
  useEffect(() => { if (!createOpen) revokePreview(); }, [createOpen, revokePreview]);

  const toggleRecordingPause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") { recorder.pause(); setRecordingPaused(true); }
    else if (recorder.state === "paused") { recorder.resume(); setRecordingPaused(false); }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await queryDashboard(`meetings:list:${activeOrgId || "default"}`, () => authFetch<{ meetings: ListItem[]; nextCursor: string | null }>("/api/meetings?limit=50", { orgId: activeOrgId || undefined }), { ttlMs: 30_000 });
      const list = r.meetings ?? [];
      setItems(list);
      setMeetingsNext(r.nextCursor);
      setSelectedId((cur) => (cur && list.some((m) => m.id === cur) ? cur : list[0]?.id ?? null));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load meetings.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => { void load(); }, [load]);

  const loadMoreMeetings = useCallback(async () => {
    if (!meetingsNext || busy === "more-meetings") return;
    setBusy("more-meetings");
    try {
      const page = await authFetch<{ meetings: ListItem[]; nextCursor: string | null }>(`/api/meetings?limit=50&cursor=${encodeURIComponent(meetingsNext)}`, { orgId: activeOrgId || undefined });
      setItems((current) => [...current, ...page.meetings.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setMeetingsNext(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more meetings.");
    } finally {
      setBusy("");
    }
  }, [meetingsNext, busy, activeOrgId]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const controller = new AbortController();
    const id = selectedId;
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    setTeamPickerOpen(false);
    setTranscriptSegments([]);
    setTranscriptNext(null);
    setTranscriptTotal(0);
    setTranscriptLoading(true);
    // NOTE: the cached fetcher must NOT take this effect's abort signal — queryDashboard
    // dedupes concurrent callers onto one promise, so aborting it here would poison the
    // shared request for the next caller (the notes-vanish-after-workspace-switch bug:
    // the switch reset aborts this run while the list reload auto-reselects the same
    // meeting and receives the already-aborted promise). Staleness is handled by the
    // `controller.signal.aborted` guards below instead.
    void queryDashboard(`meetings:overview:${activeOrgId || "default"}:${id}`, () => authFetch<Overview>(`/api/meetings/${id}/overview`, { orgId: activeOrgId || undefined }), { ttlMs: 30_000 }).then((overview) => {
      if (!controller.signal.aborted) { setDetail({ ...overview, transcript: [] }); setShareOpen(false); }
    }).catch((caught) => {
      if (!controller.signal.aborted) {
        setDetail(null);
        setDetailError(caught instanceof Error ? caught.message : "Could not load this meeting.");
      }
    }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    void authFetch<TranscriptPage>(`/api/meetings/${id}/transcript?limit=100`, { signal: controller.signal, orgId: activeOrgId || undefined }).then((page) => {
      if (controller.signal.aborted) return;
      setTranscriptSegments(page.segments);
      setTranscriptNext(page.nextCursor);
      setTranscriptTotal(page.total);
    }).catch(() => {}).finally(() => { if (!controller.signal.aborted) setTranscriptLoading(false); });
    return () => controller.abort();
    // Keyed on selectedId only: a workspace switch always clears the selection (via
    // the activeOrgId reset effect; the detail then reloads under the new org through
    // a fresh selection), while the harmless startup "" -> org-id resolution leaves
    // the selection untouched — so re-running here on activeOrgId would only flash
    // the detail on first paint.
  }, [selectedId]);

  const loadMoreTranscript = useCallback(async () => {
    if (!detail || !transcriptNext || transcriptLoading) return;
    const id = detail.id;
    setTranscriptLoading(true);
    try {
      const page = await authFetch<TranscriptPage>(`/api/meetings/${id}/transcript?limit=100&cursor=${encodeURIComponent(transcriptNext)}`, { orgId: activeOrgId || undefined });
      if (detail.id === id) setTranscriptSegments((current) => [...current, ...page.segments]);
      setTranscriptNext(page.nextCursor);
      setTranscriptTotal(page.total);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more transcript.");
    } finally {
      setTranscriptLoading(false);
    }
  }, [detail, transcriptNext, transcriptLoading, activeOrgId]);

  // Load the SELECTED org's teams lazily the first time the share menu opens —
  // most meetings never get shared to a team, so we don't fetch on load. The list
  // is org-scoped (organization teams for the selected org + the caller's personal
  // teams) so the picker can group them and offer an org-linked create.
  const loadTeams = useCallback(async () => {
    try {
      const teamsResult = await queryDashboard(`teams:list:${activeOrgId || "default"}`, () => adminApi.listTeams(activeOrgId || undefined), { ttlMs: 30_000 });
      setTeams(teamsResult.teams ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load teams.");
    } finally {
      setTeamsLoaded(true);
    }
  }, [activeOrgId]);

  useEffect(() => { if (shareOpen && !teamsLoaded) void loadTeams(); }, [shareOpen, teamsLoaded, loadTeams]);

  // A personal workspace cannot own organization teams, so org-linked affordances
  // only appear when the active workspace is a real shared organization.
  const shareOrg = activeOrg && activeOrg.isPersonal !== true ? activeOrg : undefined;
  const organizationTeams = useMemo(() => teams.filter((team) => team.kind === "organization"), [teams]);
  const personalTeams = useMemo(() => teams.filter((team) => team.kind === "personal"), [teams]);

  // Switching workspace (via the global sidebar switcher) re-scopes everything:
  // meetings are org-partitioned, so drop the open meeting/detail, close the share
  // menu, and let the list + team picker reload for the new context. Skips the
  // initial resolution (prev === null) so first paint doesn't flash a reset.
  const prevOrgRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevOrgRef.current;
    prevOrgRef.current = activeOrgId;
    if (prev === null || prev === activeOrgId) return;
    setSelectedId(null);
    setDetail(null);
    setShareOpen(false);
    setTeamPickerOpen(false);
    setTeams([]);
    setTeamsLoaded(false);
  }, [activeOrgId]);

  // Team scope REQUIRES a teamId (the backend 400s without one). Selecting the
  // Team row with no team chosen just reveals the picker; a concrete team POSTs.
  const setScope = useCallback(async (scope: Scope, teamId?: string, justCreated?: Team) => {
    if (!detail) return;
    if (scope === "team" && !teamId) { setTeamPickerOpen(true); return; }
    // Defence in depth: only share to a team the caller actually belongs to. The
    // server also enforces this (assertUserInTeam), so this just fails fast in the
    // UI. A team created a moment ago is passed explicitly because the `teams`
    // state captured by this closure does not include it yet.
    const known = justCreated ? [...teams, justCreated] : teams;
    if (scope === "team" && teamId && known.length && !known.some((t) => t.id === teamId)) {
      setError("You can only share to a team you belong to.");
      return;
    }
    setBusy("share");
    try {
      const body = scope === "team" ? { scope, teamId } : { scope };
      const share = await authFetch<Share>(`/api/meetings/${detail.id}/scope`, { method: "POST", body, orgId: activeOrgId || undefined });
      invalidateDashboardQueries(`meetings:overview:${activeOrgId || "default"}:${detail.id}`);
      setDetail((d) => (d ? { ...d, share } : d));
      setItems((list) => list.map((m) => (m.id === detail.id ? { ...m, scope } : m)));
      if (scope !== "team") setTeamPickerOpen(false);
      setShareOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change sharing.");
    } finally { setBusy(""); }
  }, [detail, teams, activeOrgId]);

  // Inline create keeps meeting sharing first-class to the enterprise structure:
  // inside a shared organization it creates an ORGANIZATION team bound to that
  // org; in a personal workspace it creates a personal cross-org team. The new
  // team is selected immediately so the meeting is shared in the same gesture.
  const createTeamInline = useCallback(async () => {
    const name = newTeamName.trim();
    if (!name) return;
    setBusy("create-team");
    try {
      const { team } = await adminApi.createTeam(name, shareOrg ? "organization" : "personal", activeOrgId || undefined);
      invalidateDashboardQueries("teams:");
      setTeams((cur) => [...cur, team]);
      setNewTeamName("");
      await setScope("team", team.id, team);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the team.");
    } finally {
      setBusy("");
    }
  }, [newTeamName, setScope, shareOrg, activeOrgId]);

  const regenerate = useCallback(async () => {
    if (!detail) return;
    setBusy("regen");
    try {
      const d = await authFetch<Detail>(`/api/meetings/${detail.id}/regenerate`, { method: "POST", orgId: activeOrgId || undefined });
      invalidateDashboardQueries(`meetings:overview:${activeOrgId || "default"}:${detail.id}`);
      setDetail(d);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not regenerate the summary.");
    } finally {
      setBusy("");
    }
  }, [detail, activeOrgId]);

  // Owner-only hard delete — also removes the transcript source + recallable
  // summary record server-side, so the meeting doesn't linger in memory recall.
  const deleteMeeting = useCallback(async () => {
    if (!detail?.canEdit) return;
    if (!window.confirm(`Delete "${detail.title}"? Its transcript, notes and recallable summary are removed permanently.`)) return;
    setBusy("delete");
    try {
      await authFetch(`/api/meetings/${detail.id}`, { method: "DELETE", orgId: activeOrgId || undefined });
      invalidateDashboardQueries("meetings:");
      setSelectedId(null);
      setDetail(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the meeting.");
    } finally {
      setBusy("");
    }
  }, [detail, activeOrgId, load]);

  const toggleAction = useCallback(async (action: ActionItem) => {
    if (!detail) return;
    const done = !action.done;
    setBusy(`action:${action.id}`);
    try {
      await authFetch(`/api/meetings/${detail.id}/actions/${action.id}`, { method: "POST", body: { done }, orgId: activeOrgId || undefined });
      invalidateDashboardQueries(`meetings:overview:${activeOrgId || "default"}:${detail.id}`);
      setDetail((d) => (d ? { ...d, actionItems: d.actionItems.map((x) => (x.id === action.id ? { ...x, done } : x)) } : d));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the action item.");
    } finally { setBusy(""); }
  }, [detail, activeOrgId]);

  // Track / untrack a meeting action — creates (or removes) a real Track work item
  // server-side, so it shows up on the Track board here and on the desktop.
  const toggleTrack = useCallback(async (action: ActionItem) => {
    if (!detail) return;
    const linked = Boolean(action.trackItemId);
    setBusy(`track:${action.id}`);
    try {
      if (linked) {
        await authFetch(`/api/meetings/${detail.id}/actions/${action.id}/track`, { method: "DELETE", orgId: activeOrgId || undefined });
        setDetail((d) => (d ? { ...d, actionItems: d.actionItems.map((x) => (x.id === action.id ? { ...x, trackItemId: undefined } : x)) } : d));
      } else {
        const res = await authFetch<{ trackItemId: string }>(`/api/meetings/${detail.id}/actions/${action.id}/track`, { method: "POST", orgId: activeOrgId || undefined });
        setDetail((d) => (d ? { ...d, actionItems: d.actionItems.map((x) => (x.id === action.id ? { ...x, trackItemId: res.trackItemId } : x)) } : d));
      }
      invalidateDashboardQueries(`meetings:overview:${activeOrgId || "default"}:${detail.id}`);
      invalidateDashboardQueries("track:");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update Track.");
    } finally { setBusy(""); }
  }, [detail, activeOrgId]);

  const submitCreate = useCallback(async () => {
    if (!draftTitle.trim() || !draftTranscript.trim()) { setCreateErr("A title and a transcript are required."); return; }
    setBusy("create");
    setCreateErr("");
    try {
      // Open question 5 — the recording's org was frozen at Record, and this is
      // the one call that could still move it. ADR-019's switcher can change the
      // active org mid-meeting; sending the CURRENT one would land an hour of
      // somebody's audio in whichever workspace happened to be selected when
      // they pressed Create. A pasted transcript has no capture and no frozen
      // scope, so it uses the active org as before.
      const captureOrgId = queueRef.current?.session.scope.orgId;
      const meetingOrgId = captureOrgId === undefined ? activeOrgId : captureOrgId;
      const out = await authFetch<{ id: string }>("/api/meetings", { method: "POST", body: { title: draftTitle.trim(), transcript: draftTranscript, template: summaryTemplate }, orgId: meetingOrgId || undefined });
      invalidateDashboardQueries("meetings:");
      // D6 — "audio is deleted when the meeting is summarized and the user has
      // accepted it". This is that moment, and only this moment: it runs after
      // the meeting exists on the server, so a failed create leaves the recording
      // on the device to be offered back rather than throwing it away.
      await releaseCapture(true);
      setCreateOpen(false);
      setDraftTitle("");
      setDraftTranscript("");
      setDraftRecovered(false);
      localStorage.removeItem("brainrouter:meeting-draft");
      await refreshRecoverable();
      await load();
      setSelectedId(out.id);
    } catch (caught) {
      setCreateErr(caught instanceof Error ? caught.message : "Could not create the meeting.");
    } finally {
      setBusy("");
    }
  }, [draftTitle, draftTranscript, summaryTemplate, load, activeOrgId, refreshRecoverable, releaseCapture]);

  const summaryBlocks = useMemo(() => renderSummary(detail?.summaryMarkdown ?? ""), [detail?.summaryMarkdown]);
  const filteredItems = useMemo(() => {
    const needle = meetingQuery.trim().toLowerCase();
    return items.filter((item) => (scopeFilter === "all" || item.scope === scopeFilter) && (!needle || item.title.toLowerCase().includes(needle)));
  }, [items, meetingQuery, scopeFilter]);

  return (
    <AuthGuard>
      <PageHeader title="Meetings" description="Recallable meeting summaries across your organization." />
      <div className={styles.page}>
      {error ? <div className={styles.errorBar} role="alert">{error}</div> : null}
      {/* D6 — outside the dialog on purpose: this is raised by the same commit
          that closes it, so anywhere inside would be unreadable by construction. */}
      {retainedAudio.map((row) => (
        <div className={styles.errorBar} role="alert" key={row.sessionId}>
          {row.message}{" "}
          <button type="button" className={styles.track} onClick={() => void releaseRetained(row.sessionId)}>Delete the audio</button>
        </div>
      ))}
      {recoveryError ? (
        <div className={styles.errorBar} role="alert">
          {recoveryError}{" "}
          <button type="button" className={styles.track} onClick={() => void refreshRecoverable()}>Check again</button>
        </div>
      ) : null}
      {/* The warning slot follows the user: the dialog covers the page, so it is
          rendered here only while there is no dialog to render it in. */}
      {!createOpen && captureWarning ? <div className={styles.errorBar} role="alert">{captureWarning}</div> : null}
      {recoverable.length ? (
        <div className={styles.errorBar} role="status">
          {recoverable.length === 1
            ? "An unfinished recording is still saved on this device."
            : `${recoverable.length} unfinished recordings are still saved on this device.`}{" "}
          <button type="button" className={styles.track} onClick={() => { setCreateErr(""); setCreateOpen(true); }}>Review</button>
        </div>
      ) : null}
      <div className={styles.wrap}>
        <div className={styles.list}>
          <div className={styles.listHead}>
            <div><span className={styles.eyebrow}>Library</span><h2>Meetings <span>{items.length}</span></h2></div>
            <button type="button" className={styles.newBtn} onClick={() => { setCreateErr(""); setCreateOpen(true); }}>+ New</button>
          </div>
          <div className={styles.listTools}>
            <label className={styles.listSearch}><span aria-hidden="true">⌕</span><span className="sr-only">Search meetings</span><input value={meetingQuery} onChange={(event) => setMeetingQuery(event.target.value)} placeholder="Search meetings" />{meetingQuery ? <button type="button" onClick={() => setMeetingQuery("")} aria-label="Clear meeting search">×</button> : null}</label>
            <div className={styles.scopeFilters} role="group" aria-label="Filter meeting visibility">
              {(["all", "private", "team", "org", "public"] as const).map((value) => <button key={value} type="button" className={scopeFilter === value ? styles.scopeFilterOn : ""} aria-pressed={scopeFilter === value} onClick={() => setScopeFilter(value)}>{value === "all" ? "All" : value === "org" ? "Org" : value[0]?.toUpperCase() + value.slice(1)}</button>)}
            </div>
          </div>
          <div className={styles.listRows}>
          {filteredItems.map((m) => (
            <button type="button" key={m.id} className={`${styles.item}${m.id === selectedId ? ` ${styles.itemOn}` : ""}`} onClick={() => setSelectedId(m.id)} aria-pressed={m.id === selectedId}>
              <div className={styles.itemT}>{m.title}</div>
              <div className={styles.itemM}><span className={styles.itemD}>{m.date}</span><span className={`${styles.statusDot} ${styles[`status_${m.summaryStatus}`]}`} title={`Summary ${m.summaryStatus}`} /><ScopeBadge scope={m.scope} />{!m.canEdit ? <span className={styles.sharedBadge}>Shared with me</span> : null}</div>
            </button>
          ))}
          {filteredItems.length === 0 ? (
            <div className={styles.listEmpty}>{loading ? <InlineLoading label="Loading meetings…" /> : items.length ? "No meetings match these filters." : "No meetings yet. Record, import audio, or paste a transcript to begin."}</div>
          ) : null}
          </div>
          {meetingsNext ? <button type="button" className={styles.listMore} disabled={busy === "more-meetings"} onClick={() => void loadMoreMeetings()}>{busy === "more-meetings" ? "Loading…" : "Load more meetings"}</button> : null}
        </div>

        {detail ? (
          <div className={styles.detail}>
            <div className={styles.dHead}>
              <div className={styles.dHeadRow}>
                <div>
                  <h3>{detail.title}</h3>
                  <div className={styles.att}>{detail.attendees.length ? detail.attendees.join(", ") : "No attendees recorded"}</div>
                </div>
                <div className={styles.hActions}>
                  {detail.canEdit ? <button type="button" className={styles.shareBtn} disabled={busy === "share"} onClick={() => setShareOpen((v) => !v)} aria-haspopup="menu" aria-expanded={shareOpen}>
                    <span className={`${styles.dot} ${SCOPE_META[detail.share.scope].dot}`} />
                    {SCOPE_META[detail.share.scope].label}
                    {detail.share.scope === "team" && detail.share.teamId ? ` · ${teams.find((t) => t.id === detail.share.teamId)?.name ?? "Team"}` : ""} ▾
                  </button> : <span className={styles.sharedBadge}>Shared with you · read only</span>}
                  {detail.model ? <span className={styles.modelChip}>{detail.model.label}{detail.model.effort ? <> · <b>{detail.model.effort}</b></> : null}</span> : null}
                  {detail.canEdit && shareOpen ? (
                    <div className={styles.pop} role="menu">
                      <div className={styles.popH}>Who can access</div>
                      {SCOPES.map((s) => {
                        const ScopeIcon = SCOPE_META[s].Icon;
                        return (
                            <button key={s} type="button" disabled={busy === "share"} className={`${styles.srow}${detail.share.scope === s ? ` ${styles.srowOn}` : ""}`} onClick={() => void setScope(s)} role="menuitemradio" aria-checked={detail.share.scope === s}>
                            <span className={styles.srowIc}><ScopeIcon size={16} /></span>
                            <span><span className={styles.srowLb}>{SCOPE_META[s].label}</span><span className={styles.srowDs}>{SCOPE_META[s].blurb}</span></span>
                          </button>
                        );
                      })}
                      {teamPickerOpen || detail.share.scope === "team" ? (
                        <div className={styles.linkzone}>
                          {!teamsLoaded ? (
                            <InlineLoading label="Loading teams…" />
                          ) : (
                            <>
                              {teams.length === 0 ? (
                                <div className={styles.teamPickH}>
                                  {shareOrg
                                    ? <>No teams in <b>{shareOrg.name}</b> yet — create the first organization team below to share this meeting.</>
                                    : "No teams yet — create a personal cross-organization team below to share this meeting."}
                                </div>
                              ) : (
                                <>
                                  <div className={styles.teamPickH}>Share with team</div>
                                  <select className={styles.teamSel} value={detail.share.teamId ?? ""} onChange={(e) => { if (e.target.value) void setScope("team", e.target.value); }} aria-label="Share with team">
                                    <option value="" disabled>Select a team…</option>
                                    {organizationTeams.length ? <optgroup label={`Organization teams — ${shareOrg?.name ?? organizationTeams[0].orgName ?? "current organization"}`}>{organizationTeams.map((team) => <option key={team.id} value={team.id}>{team.name}{team.orgName ? ` · ${team.orgName}` : ""}</option>)}</optgroup> : null}
                                    {personalTeams.length ? <optgroup label="Personal teams · cross-organization · explicit access">{personalTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</optgroup> : null}
                                  </select>
                                  {shareOrg && organizationTeams.length === 0 ? (
                                    <div className={styles.teamPickNote}>No organization teams in <b>{shareOrg.name}</b> yet — create one below to keep this meeting linked to your organization.</div>
                                  ) : null}
                                </>
                              )}
                              <div className={styles.teamCreateLabel}>{shareOrg ? <>Create team in <b>{shareOrg.name}</b></> : "Create personal team"}</div>
                              <div className={styles.teamCreateRow}>
                                <input value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} placeholder={shareOrg ? "Team name (e.g. Platform)" : "Team name (e.g. Research circle)"} aria-label="New team name" onKeyDown={(e) => { if (e.key === "Enter") void createTeamInline(); }} />
                                <button type="button" onClick={() => void createTeamInline()} disabled={busy === "create-team" || !newTeamName.trim()}>{busy === "create-team" ? "Creating…" : "Create"}</button>
                              </div>
                            </>
                          )}
                        </div>
                      ) : null}
                      {detail.share.scope === "public" && detail.share.publicUrl ? (
                        <div className={styles.linkzone}>
                          <div className={styles.linkrow}>
                            <input readOnly value={detail.share.publicUrl} aria-label="Public link" />
                            <button type="button" onClick={() => { void navigator.clipboard?.writeText(detail.share.publicUrl ?? ""); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }}>{copied ? "Copied" : "Copy"}</button>
                          </div>
                          <div className={styles.linkMeta}>
                            <span>{detail.share.expiresAt ? `Expires ${detail.share.expiresAt} · ` : ""}summary only</span>
                            <button type="button" className={styles.revoke} onClick={() => void setScope("private")}>Revoke link</button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className={styles.metastrip}>
                <span className={styles.chip}><i />{detail.status ? detail.status[0].toUpperCase() + detail.status.slice(1) : "Recorded"}</span>
                <span className={styles.chip}>{detail.date}</span>
                {detail.durationMin ? <span className={styles.chip}>{detail.durationMin} min</span> : null}
                {detail.wordCount ? <span className={styles.chip}>{detail.wordCount.toLocaleString()} words</span> : null}
                {detail.canEdit ? <button type="button" className={styles.chip} onClick={() => void regenerate()}
                  disabled={busy === "regen" || detail.summaryStatus === "processing" || detail.summaryStatus === "queued"} style={{ cursor: "pointer" }}>
                  {detail.summaryStatus === "processing" || detail.summaryStatus === "queued" ? "● Summarizing…" : busy === "regen" ? "Regenerating…" : "↻ Regenerate"}
                </button> : null}
                {detail.canEdit ? <button type="button" className={`${styles.chip} ${styles.chipDanger}`} onClick={() => void deleteMeeting()} disabled={busy === "delete"} style={{ cursor: "pointer" }}>
                  {busy === "delete" ? "Deleting…" : "Delete"}
                </button> : null}
              </div>
            </div>
            <div className={styles.body}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                <div className={styles.card}>
                  <div className={styles.cardLab} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>Summary</span>
                    {detail.canEdit && detail.summaryStatus === "ready" && !editing ? (
                      <button type="button" className={styles.track} onClick={() => { setDraftSummary(detail.summaryMarkdown); setEditing(true); }}>✎ Edit</button>
                    ) : null}
                  </div>
                  {detail.summaryStatus === "processing" || detail.summaryStatus === "queued" ? (
                    <div className={styles.empty}>● Generating notes… this keeps running on the server — you can leave or refresh.</div>
                  ) : detail.summaryStatus === "failed" ? (
                    <div className={styles.errorBar} role="alert">{(detail.summaryError || "Summary generation failed.") + (detail.canEdit ? " Check the meeting-summary model, then Regenerate." : " The meeting owner can regenerate it.")}</div>
                  ) : editing ? (
                    <>
                      <textarea className={styles.modalTextarea} value={draftSummary} onChange={(e) => setDraftSummary(e.target.value)} rows={12} aria-label="Edit summary" />
                      <div className={styles.modalActions}>
                        <button type="button" className={styles.track} onClick={() => setEditing(false)}>Cancel</button>
                        <button type="button" className={styles.newBtn} onClick={() => void saveSummary()} disabled={busy === "save-summary"}>{busy === "save-summary" ? "Saving…" : "Save"}</button>
                      </div>
                    </>
                  ) : (
                    summaryBlocks
                  )}
                </div>
                {detail.actionItems.length ? (
                  <div className={styles.card}>
                    <div className={styles.cardLab}>Action items</div>
                    {detail.actionItems.map((a) => (
                      <div key={a.id} className={styles.ai}>
                        <label className={styles.aiTxt} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: detail.canEdit ? "pointer" : "default" }}>
                          <input type="checkbox" checked={Boolean(a.done)} disabled={!detail.canEdit || busy === `action:${a.id}`} onChange={() => void toggleAction(a)} style={{ marginTop: 3 }} />
                          <span style={a.done ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>
                            {a.title}{a.assignee ? <span className={styles.aiWho}>→ {a.assignee}</span> : null}
                          </span>
                        </label>
                        {detail.canEdit ? <button type="button" className={styles.track} disabled={busy === `track:${a.id}`} title={a.trackItemId ? "Remove from Track" : "Add to Track"} onClick={() => void toggleTrack(a)}>{busy === `track:${a.id}` ? "Updating…" : a.trackItemId ? "In Track ✓" : "Track ↗"}</button> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className={styles.card}>
                <div className={styles.cardLab}>Transcript {transcriptTotal ? <span className={styles.transcriptCount}>{transcriptSegments.length} / {transcriptTotal}</span> : null}</div>
                {transcriptSegments.length ? <TranscriptLines segments={transcriptSegments} /> : <div className={styles.empty}>{transcriptLoading ? "Loading transcript…" : "No transcript."}</div>}
                {transcriptNext ? <button type="button" className={styles.loadMore} disabled={transcriptLoading} onClick={() => void loadMoreTranscript()}>{transcriptLoading ? "Loading…" : "Load 100 more"}</button> : null}
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.detail}><div className={styles.empty}>{detailLoading ? <InlineLoading label="Loading meeting…" /> : detailError ? <><strong>Meeting unavailable</strong><span>{detailError}</span><button type="button" className={styles.track} onClick={() => { const id = selectedId; setSelectedId(null); queueMicrotask(() => setSelectedId(id)); }}>Try again</button></> : items.length ? "Select a meeting." : "No meeting selected."}</div></div>
        )}
      </div>

      {createOpen ? (
        <div className={styles.modalScrim} role="dialog" aria-modal="true" aria-labelledby="new-meeting-title" onClick={() => setCreateOpen(false)} onKeyDown={(event) => { if (event.key === "Escape") setCreateOpen(false); }}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHead}><div><span className={styles.eyebrow}>Capture</span><h2 id="new-meeting-title">New meeting</h2></div><button type="button" onClick={() => setCreateOpen(false)} aria-label="Close new meeting dialog">×</button></div>
            <input
              className={styles.modalInput}
              placeholder="Title (e.g. Weekly product sync)"
              value={draftTitle}
              autoFocus
              onChange={(e) => setDraftTitle(e.target.value)}
              aria-label="Meeting title"
            />
            <textarea
              className={styles.modalTextarea}
              placeholder="Paste a transcript, or record above — Whisper produces plain text (no speaker labels)."
              value={draftTranscript}
              onChange={(e) => setDraftTranscript(e.target.value)}
              rows={10}
              aria-label="Transcript"
            />
            <div className={styles.captureOptions}>
              <label>Template<select value={summaryTemplate} onChange={(event) => setSummaryTemplate(event.target.value)} aria-label="Meeting summary template"><option value="general">General notes</option><option value="standup">Standup</option><option value="one-on-one">1:1</option><option value="retrospective">Retrospective</option></select></label>
              <label>Language<select value={language} onChange={(event) => setLanguage(event.target.value)} aria-label="Transcription language"><option value="auto">Auto detect</option><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="ja">Japanese</option><option value="ko">Korean</option><option value="zh">Chinese</option></select></label>
              <label className={styles.importAudio}>Import audio<input type="file" accept="audio/*,.webm,.m4a,.mp3,.wav,.ogg" onChange={(event) => { const file = event.target.files?.[0]; if (file) void transcribe(file); event.target.value = ""; }} /></label>
              <span>{draftRecovered ? "Recovered your saved draft" : "Drafts are saved on this device"}</span>
            </div>
            {recoverable.length ? (
              <div className={styles.linkzone}>
                <div className={styles.teamPickH}>Unfinished recordings on this device</div>
                {recoverable.map((record) => {
                  // The summary is the shared one, so a recovered meeting is
                  // described here exactly as the desktop describes it — and it
                  // already knows how much of the transcript survived.
                  const summary = summarizeRecovery(restoreCaptureSession({ record, scope: { orgId: activeOrgId || null } }));
                  return (
                    <Fragment key={record.sessionId}>
                      <div className={styles.recoverRow}>
                        <span className={styles.recoverWhat}>
                          <b>{summary.title}</b>
                          <span>
                            {new Date(summary.startedAt).toLocaleString()} · {formatCaptureBytes(summary.byteLength)} · {summary.segments} segment{summary.segments === 1 ? "" : "s"}
                            {summary.settled ? ` · ${summary.settled} transcribed` : ""}
                            {summary.gaps ? ` · ${summary.gaps} gap${summary.gaps === 1 ? "" : "s"}` : ""}
                          </span>
                        </span>
                        <span className={styles.recoverActions}>
                          {/* §6 — "on disk AND PLAYABLE". Without this the
                              destructive test can only ever be half-passed: the
                              session and the transcript come back and the user
                              cannot hear a second of what they recorded. */}
                          <button type="button" className={styles.track} disabled={busy === "preview"} aria-pressed={preview?.sessionId === record.sessionId} onClick={() => void previewCapture(record)}>
                            {preview?.sessionId === record.sessionId ? "Hide audio" : busy === "preview" ? "Reading…" : "Play"}
                          </button>
                          <button type="button" className={styles.newBtn} disabled={busy === "transcribe" || recording} onClick={() => void pickUpCapture(record)}>Pick up</button>
                          <button type="button" className={styles.track} disabled={busy === "transcribe"} onClick={() => void discardCapture(record)}>Discard</button>
                        </span>
                      </div>
                      {preview?.sessionId === record.sessionId ? (
                        <div className={styles.recoverPlayer}>
                          {/* No caption track, deliberately: the text of this
                              recording is the transcript in the box above, which
                              is what the segments have been producing all along. */}
                          <audio src={preview.url} controls preload="metadata" aria-label={`Recording started ${new Date(summary.startedAt).toLocaleString()}`} />
                          {/* D5's rule, one layer down: a player that silently
                              skipped unreadable chunks would be the "quietly
                              wrong" recording rather than the honest one. */}
                          {preview.missing ? (
                            <small>{preview.missing} segment{preview.missing === 1 ? "" : "s"} of this recording could not be read back and {preview.missing === 1 ? "is" : "are"} missing from what plays here.</small>
                          ) : null}
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
                <div className={styles.teamPickNote}>Audio never leaves this device except one segment at a time as it transcribes, and is deleted once the meeting is created or you discard it.</div>
              </div>
            ) : null}
            {captureSession ? (
              <LiveTranscript session={captureSession} phase={capturePhase} retrying={retryingSegment} onRetry={(index) => void retrySegment(index)} />
            ) : null}
            {captureRevisionPending ? (
              <div className={styles.linkzone}>
                <div className={styles.teamPickH}>
                  The transcript has moved on since you edited the box above. Your own words are kept: new text is added at the end, and a gap that has since been filled in is replaced where it stands.
                </div>
                <button type="button" className={styles.newBtn} onClick={appendCaptureText}>Bring the transcript up to date</button>
              </div>
            ) : null}
            {/* Two slots, and the order is the point. `captureNotice` is a
                READING — the store's kind and how much room is left — rewritten
                by every chunk and blank most of the time. `captureWarning` is an
                EVENT that is still true: a persist that failed, a manifest that
                could not be written, a store that filled up. They used to share
                one slot, so the highest-frequency writer won and every warning
                that mattered was erased by the next timeslice while it was still
                the case. The warning is rendered second, next to the actions, so
                it is the last thing read before Create. */}
            {captureNotice ? <div className={styles.errorBar} role="status">{captureNotice}</div> : null}
            {captureWarning ? <div className={styles.errorBar} role="alert">{captureWarning}</div> : null}
            {createErr ? <div className={styles.errorBar} role="alert">{createErr}</div> : null}
            <div className={styles.modalActions} style={{ justifyContent: "space-between" }}>
              <div className={styles.recordActions}><button type="button" className={styles.track} onClick={() => (recording ? stopRecording() : void startRecording())} disabled={busy === "transcribe"}>{recording ? "■ Stop recording" : busy === "transcribe" ? "Transcribing…" : <><Microphone size={13} weight="fill" /> Record</>}</button>{recording ? <button type="button" className={styles.track} onClick={toggleRecordingPause}>{recordingPaused ? "▶ Resume" : "Ⅱ Pause"}</button> : null}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className={styles.track} onClick={() => { if (recording) stopRecording(); setCreateOpen(false); }}>Cancel</button>
                <button type="button" className={styles.newBtn} onClick={() => void submitCreate()} disabled={busy === "create" || recording}>
                  {busy === "create" ? "Creating…" : "Create + summarize"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </AuthGuard>
  );
}

function renderSummary(md: string) {
  const out: ReactElement[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { out.push(<ul key={`u${out.length}`}>{list.map((li, i) => <li key={i}>{li}</li>)}</ul>); list = []; } };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith("- ")) { list.push(line.slice(2)); continue; }
    flush();
    if (line.startsWith("#")) out.push(<h4 key={out.length}>{line.replace(/^#+\s*/, "")}</h4>);
    else out.push(<p key={out.length}>{line}</p>);
  }
  flush();
  return out;
}
