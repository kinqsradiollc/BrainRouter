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
 * session is offered back on the next load. The store is `lib/meetings/`.
 * Nothing here defers work to an unload handler — a closing tab gets very little
 * time, so nothing important may depend on it running.
 *
 * **The recording itself is not in this file any more, and that is the point.**
 * `captureSurface.ts` owns every decision about a capture that is being written:
 * the cross-tab lock, the chunk write, composition, the POST, the destructive controls
 * and the unmount teardown. This page supplies the browser — a real
 * `MediaRecorder`, the durable store, `authFetch`, timers — renders what the
 * surface says, and owns the meeting LIBRARY beside it.
 *
 * The split is structural rather than cosmetic. Every dashboard defect this ADR
 * has had to repair lived in this component, and a 1900-line component can only
 * be checked by reading it: its wiring was pinned by regular expressions over
 * its own source text, which cannot tell you what a value WAS. Three rounds of
 * that produced a respelled `base:` (the doubled transcript), a deleted
 * `transcript = settled.text` (the unmarked hole) and a `meetingOrgId` that
 * could be respelled `activeOrgId` with nothing able to notice (a meeting
 * landing in the wrong workspace). Behind the seam, `captureSurface.test.ts`
 * presses Record, hands over a chunk, navigates away, and reads what actually
 * reached the POST.
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
 *
 * ADR-035 D4 — and the text goes into the box by ONE rule, the shared
 * `foldTranscript`, which appends from where it left off and never moves a line
 * the box already holds. This page used to have a second answer: it recomposed
 * `base + transcriptText(session)` on every drain over a base with every segment
 * stripped out of it, which put all of the person's own words first and the
 * whole meeting after them. A note typed BETWEEN two segments came back above
 * the entire transcript across a kill, and an edit to the last settled segment
 * came back reverted AND relocated to the top — both silent, both POSTed, both
 * on this host only. Position in that box is the person's, not this surface's.
 *
 * ADR-035 D6 — the compose draft lives in that same protected store, not in
 * `localStorage` (`meetingDraft.ts`): the words of a meeting do not belong in a
 * store any page script can read. It holds the compose box WHOLE — exactly what
 * the person can see themselves having typed. The doubling a recovered meeting
 * used to arrive with is prevented on the way back IN, by reconciling the
 * restored box against the session once in `attachQueue`, and never by writing
 * a stripped copy of it down.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { Lock, UsersThree, Buildings, GlobeHemisphereWest, Microphone, type Icon } from "@phosphor-icons/react";
import { summarizeRecovery } from "@kinqs/brainrouter-core/meetings";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { InlineLoading } from "../../components/LoadingSpinner";
import { adminApi, authFetch, type Team } from "../../lib/adminApi";
import { useActiveOrg } from "../../components/OrgWorkspaceProvider";
import { BASE_URL } from "../../lib/client";
import { getApiKey, getJwt } from "../../lib/client-auth";
import { invalidateDashboardQueries, queryDashboard } from "../../lib/dashboardQuery";
import { browserCaptureLocks, CAPTURE_HELD_ELSEWHERE } from "../../lib/meetings/captureLock";
import { createSttTranscriber, DEFAULT_CAPTURE_MIME_TYPE } from "../../lib/meetings/captureQueue";
import { openMeetingCaptureStore } from "../../lib/meetings/openCaptureStore";
import { formatCaptureBytes } from "../../lib/meetings/storageBudget";
import { MeetingCaptureSurface, type CaptureSurfacePorts } from "./captureSurface";
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

const SCOPE_META: Record<Scope, { label: string; blurb: string; badge: string; dot: string; Icon: Icon }> = {
  private: { label: "Private", blurb: "Only you can see this meeting.", badge: styles.bPrivate, dot: "", Icon: Lock },
  team: { label: "Team", blurb: "Members of your team can recall it.", badge: styles.bTeam, dot: styles.dotTeam, Icon: UsersThree },
  org: { label: "Organization", blurb: "Everyone in your organization.", badge: styles.bOrg, dot: styles.dotOrg, Icon: Buildings },
  public: { label: "Public", blurb: "Anyone with the link — redacted summary only.", badge: styles.bPublic, dot: styles.dotPublic, Icon: GlobeHemisphereWest },
};
const SCOPES: Scope[] = ["private", "team", "org", "public"];

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
  const [editing, setEditing] = useState(false);
  const [draftSummary, setDraftSummary] = useState("");
  const [meetingQuery, setMeetingQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<Scope | "all">("all");
  const [copied, setCopied] = useState(false);

  // ADR-035 — everything about a recording that is being WRITTEN lives in
  // `captureSurface.ts`, which is a plain object with no React in it, and this
  // page renders what it says. That is not tidiness: this component is the file
  // every dashboard defect in this ADR has lived in, and a component can only be
  // checked by reading it. Behind the seam a test presses Record, hands over a
  // chunk, kills the tab and reads what actually reached the POST.
  //
  // The switcher's org and the page's own `busy` are read through refs, so the
  // surface always sees the CURRENT value without being rebuilt — rebuilding it
  // would drop the recording it is holding, which is the defect it exists to fix.
  // The id of a meeting the surface has just created, so the library reload and
  // the selection stay here, where the library lives.
  const [createdMeetingId, setCreatedMeetingId] = useState<string | null>(null);
  const activeOrgRef = useRef(activeOrgId);
  activeOrgRef.current = activeOrgId;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const capture = useMemo(() => {
    const ports: CaptureSurfacePorts = {
      // One per TAB, over `navigator.locks`: a lock this tab holds is released
      // by the browser the moment the tab dies, so a killed recording is
      // offerable back on the very next check rather than after a threshold.
      locks: browserCaptureLocks(),
      openStore: (requestPersistence) => openMeetingCaptureStore({ requestPersistence }),
      activeOrgId: () => activeOrgRef.current,
      async openMicrophone() {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream);
        } catch (caught) {
          // A recorder that could not be constructed leaves the stream live and
          // `onstop` never fires, so the microphone would stay open forever.
          stream.getTracks().forEach((track) => track.stop());
          throw caught;
        }
        // A thin adapter rather than the `MediaRecorder` itself: the DOM's event
        // handlers carry a whole `BlobEvent`, and the surface is written against
        // the two facts it actually uses so a test can be a plain object.
        return {
          recorder: {
            get mimeType() { return recorder.mimeType; },
            get state() { return recorder.state; },
            start: (timesliceMs: number) => recorder.start(timesliceMs),
            stop: () => recorder.stop(),
            pause: () => recorder.pause(),
            resume: () => recorder.resume(),
            set ondataavailable(handler: ((event: { readonly data: Blob }) => void) | null) {
              recorder.ondataavailable = handler ? (event) => handler({ data: event.data }) : null;
            },
            get ondataavailable() { return null; },
            set onstop(handler: (() => void) | null) { recorder.onstop = handler; },
            get onstop() { return null; },
          },
          release: () => stream.getTracks().forEach((track) => track.stop()),
        };
      },
      createTranscriber: (language) => createSttTranscriber({
        baseUrl: BASE_URL,
        token: getJwt() || getApiKey() || "",
        ...(language ? { language } : {}),
      }),
      createMeeting: (input) => authFetch<{ id: string }>("/api/meetings", {
        method: "POST",
        body: { title: input.title, transcript: input.transcript, template: input.template },
        orgId: input.orgId || undefined,
      }),
      async transcribeFile(blob, language) {
        const token = getJwt() || getApiKey() || "";
        const res = await fetch(`${BASE_URL}/v1/audio/transcriptions${language === "auto" ? "" : `?language=${encodeURIComponent(language)}`}`, {
          method: "POST",
          headers: { "Content-Type": blob.type || DEFAULT_CAPTURE_MIME_TYPE, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: blob,
        });
        if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
        const out = (await res.json()) as { text?: string };
        return out.text ?? "";
      },
      legacyDraftStorage: () => (typeof localStorage === "undefined" ? null : localStorage),
      confirm: (question) => window.confirm(question),
      now: () => Date.now(),
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (handle) => window.clearTimeout(handle),
      createObjectUrl: (blob) => URL.createObjectURL(blob),
      revokeObjectUrl: (url) => URL.revokeObjectURL(url),
      warn: (message, detail) => (detail === undefined ? console.warn(message) : console.warn(message, detail)),
      otherBusy: () => Boolean(busyRef.current),
      onCreated: (meetingId) => setCreatedMeetingId(meetingId),
    };
    return new MeetingCaptureSurface(ports);
  }, []);
  const cap = useSyncExternalStore(capture.subscribe, capture.snapshot, capture.snapshot);
  // Derived from the snapshot above, so both are recomputed on the same render.
  const unresolved = capture.unresolved;

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

  // ADR-035 — the capture surface's lifecycle, and nothing else about it lives
  // here. `init` restores the compose draft once; the recovery offer is re-asked
  // whenever the workspace moves, because the offer is scoped to it; and
  // `dispose` is the unmount teardown.
  //
  // That teardown is the whole of defect A. Without it a client-side navigation
  // away from /meetings left the `MediaRecorder` RUNNING with the microphone
  // open, still writing chunks through its closure, while the remounted page had
  // a fresh empty guard — so the live session appeared in the recovery offer
  // with an enabled Discard beside it, and there was no way to stop it:
  // `recording` was false, the button said "Record", and pressing it started a
  // SECOND concurrent recorder over a SECOND session while the first kept
  // writing into the first. The desktop grew exactly this teardown; D1b says the
  // browser gets the same guarantee and not a lesser one.
  useEffect(() => {
    void capture.init();
    return () => { void capture.dispose(); };
  }, [capture]);
  useEffect(() => { void capture.refreshRecoverable(); }, [capture, activeOrgId]);

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

  // The surface created a meeting; the LIBRARY is this page's, so refreshing it
  // and selecting the new row stays here. Kept as an effect over an id rather
  // than a callback handed across the seam, because `load` closes over the org
  // and the surface must never be rebuilt when that changes.
  useEffect(() => {
    if (!createdMeetingId) return;
    setCreatedMeetingId(null);
    invalidateDashboardQueries("meetings:");
    void load().then(() => setSelectedId(createdMeetingId));
  }, [createdMeetingId, load]);

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
      {cap.retained.map((row) => (
        <div className={styles.errorBar} role="alert" key={row.sessionId}>
          {row.message}{" "}
          <button type="button" className={styles.track} onClick={() => void capture.releaseRetained(row.sessionId)}>Delete the audio</button>
        </div>
      ))}
      {cap.recoveryError ? (
        <div className={styles.errorBar} role="alert">
          {cap.recoveryError}{" "}
          <button type="button" className={styles.track} onClick={() => void capture.refreshRecoverable()}>Check again</button>
        </div>
      ) : null}
      {/* Both capture slots follow the user. The × and the scrim close this
          dialog WITHOUT stopping the recording, so a meeting can be captured
          with nothing of it on screen — and a durability warning rendered only
          inside a closed dialog is a warning nobody can act on. They are
          rendered here exactly while there is no dialog to render them in. */}
      {!cap.createOpen && cap.warning ? <div className={styles.errorBar} role="alert">{cap.warning}</div> : null}
      {!cap.createOpen && cap.notice ? <div className={styles.errorBar} role="status">{cap.notice}</div> : null}
      {/* Golden rule 23 — this browser has no Web Locks, so it cannot see what
          another tab is recording. A degradation nobody is shown is
          indistinguishable from working, and this one can cost a meeting. */}
      {!cap.createOpen && cap.coordination ? <div className={styles.errorBar} role="status">{cap.coordination}</div> : null}
      {!cap.createOpen && cap.recording ? (
        <div className={styles.errorBar} role="status">
          A meeting is being recorded. Its audio is being saved to this device.{" "}
          <button type="button" className={styles.track} onClick={() => capture.openDialog()}>Back to the recording</button>
        </div>
      ) : null}
      {cap.recoverable.length ? (
        <div className={styles.errorBar} role="status">
          {cap.recoverable.length === 1
            ? "An unfinished recording is still saved on this device."
            : `${cap.recoverable.length} unfinished recordings are still saved on this device.`}{" "}
          <button type="button" className={styles.track} onClick={() => capture.openDialog()}>Review</button>
        </div>
      ) : null}
      <div className={styles.wrap}>
        <div className={styles.list}>
          <div className={styles.listHead}>
            <div><span className={styles.eyebrow}>Library</span><h2>Meetings <span>{items.length}</span></h2></div>
            <button type="button" className={styles.newBtn} onClick={() => capture.openDialog()}>+ New</button>
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

      {cap.createOpen ? (
        <div className={styles.modalScrim} role="dialog" aria-modal="true" aria-labelledby="new-meeting-title" onClick={() => capture.closeDialog()} onKeyDown={(event) => { if (event.key === "Escape") capture.closeDialog(); }}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHead}><div><span className={styles.eyebrow}>Capture</span><h2 id="new-meeting-title">New meeting</h2></div><button type="button" onClick={() => capture.closeDialog()} aria-label="Close new meeting dialog">×</button></div>
            <input
              className={styles.modalInput}
              placeholder="Title (e.g. Weekly product sync)"
              value={cap.title}
              autoFocus
              onChange={(e) => capture.setTitle(e.target.value)}
              aria-label="Meeting title"
            />
            <textarea
              className={styles.modalTextarea}
              placeholder="Paste a transcript, or record above — Whisper produces plain text (no speaker labels)."
              value={cap.transcript}
              onChange={(e) => capture.setTranscript(e.target.value)}
              rows={10}
              aria-label="Transcript"
            />
            <div className={styles.captureOptions}>
              <label>Template<select value={cap.template} onChange={(event) => capture.setTemplate(event.target.value)} aria-label="Meeting summary template"><option value="general">General notes</option><option value="standup">Standup</option><option value="one-on-one">1:1</option><option value="retrospective">Retrospective</option></select></label>
              <label>Language<select value={cap.language} onChange={(event) => capture.setLanguage(event.target.value)} aria-label="Transcription language"><option value="auto">Auto detect</option><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="ja">Japanese</option><option value="ko">Korean</option><option value="zh">Chinese</option></select></label>
              <label className={styles.importAudio}>Import audio<input type="file" accept="audio/*,.webm,.m4a,.mp3,.wav,.ogg" onChange={(event) => { const file = event.target.files?.[0]; if (file) void capture.importAudio(file); event.target.value = ""; }} /></label>
              <span>{cap.draftRecovered ? "Recovered your saved draft" : "Drafts are saved on this device"}</span>
            </div>
            {cap.recoverable.length ? (
              <div className={styles.linkzone}>
                <div className={styles.teamPickH}>Unfinished recordings on this device</div>
                {cap.recoverable.map((entry) => {
                  // The summary is the shared one, so a recovered meeting is
                  // described here exactly as the desktop describes it — and it
                  // already knows how much of the transcript survived. The
                  // session comes from the offer, which restored it once under
                  // the rule that decided it was offerable at all.
                  const summary = summarizeRecovery(entry.session);
                  // D6 — the button says what the function will refuse. The
                  // offer already excludes a capture somebody is writing to, so
                  // this is the belt beside `discard`'s braces: a listing taken
                  // a moment ago and a tab that started recording since. The
                  // function asks the browser again on the click, which is the
                  // answer that actually decides.
                  const writer = cap.writing.includes(entry.record.sessionId) ? CAPTURE_HELD_ELSEWHERE : null;
                  return (
                    <Fragment key={entry.record.sessionId}>
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
                          <button type="button" className={styles.track} disabled={cap.busy === "preview"} aria-pressed={cap.preview?.sessionId === entry.record.sessionId} onClick={() => void capture.previewCapture(entry.record)}>
                            {cap.preview?.sessionId === entry.record.sessionId ? "Hide audio" : cap.busy === "preview" ? "Reading…" : "Play"}
                          </button>
                          <button type="button" className={styles.newBtn} disabled={cap.busy === "transcribe" || cap.recording || Boolean(writer)} onClick={() => void capture.pickUp(entry)}>Pick up</button>
                          <button type="button" className={styles.track} disabled={cap.busy === "transcribe" || Boolean(writer)} title={writer ?? undefined} onClick={() => void capture.discard(entry.record)}>Discard</button>
                        </span>
                      </div>
                      {cap.preview?.sessionId === entry.record.sessionId ? (
                        <div className={styles.recoverPlayer}>
                          {/* No caption track, deliberately: the text of this
                              recording is the transcript in the box above, which
                              is what the segments have been producing all along. */}
                          <audio src={cap.preview.url} controls preload="metadata" aria-label={`Recording started ${new Date(summary.startedAt).toLocaleString()}`} />
                          {/* D5's rule, one layer down: a player that silently
                              skipped unreadable chunks would be the "quietly
                              wrong" recording rather than the honest one. */}
                          {cap.preview.missing ? (
                            <small>{cap.preview.missing} segment{cap.preview.missing === 1 ? "" : "s"} of this recording could not be read back and {cap.preview.missing === 1 ? "is" : "are"} missing from what plays here.</small>
                          ) : null}
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
                <div className={styles.teamPickNote}>Audio never leaves this device except one segment at a time as it transcribes, and is deleted once the meeting is created or you discard it.</div>
              </div>
            ) : null}
            {cap.session ? (
              <LiveTranscript session={cap.session} phase={cap.phase} retrying={cap.retrying} onRetry={(index) => void capture.retrySegment(index)} />
            ) : null}
            {/* There is deliberately no catch-up affordance here any more. It
                existed because automatic composition switched OFF for good the
                moment a person typed, so new text had to be withheld and then
                offered back. Under the append-only fold nothing is ever
                withheld from the box, so there is nothing left to offer. */}
            {/* Two slots, and the order is the point. `captureNotice` is a
                READING — the store's kind and how much room is left — rewritten
                by every chunk and blank most of the time. `captureWarning` is an
                EVENT that is still true: a persist that failed, a manifest that
                could not be written, a store that filled up. They used to share
                one slot, so the highest-frequency writer won and every warning
                that mattered was erased by the next timeslice while it was still
                the case. The warning is rendered second, next to the actions, so
                it is the last thing read before Create. */}
            {cap.notice ? <div className={styles.errorBar} role="status">{cap.notice}</div> : null}
            {cap.coordination ? <div className={styles.errorBar} role="status">{cap.coordination}</div> : null}
            {cap.warning ? <div className={styles.errorBar} role="alert">{cap.warning}</div> : null}
            {cap.createError ? <div className={styles.errorBar} role="alert">{cap.createError}</div> : null}
            {/* D5, said in advance. Creating the meeting is what turns an
                unresolved segment into a printed gap AND deletes the audio it
                would have been filled in from, so this is the last moment the
                choice exists. */}
            {cap.recording ? (
              <div className={styles.teamPickNote}>Stop the recording before creating the meeting — creating it releases the captured audio, and the chunk being written right now would have nowhere to land.</div>
            ) : cap.settling ? (
              /* The window after Stop, which the surface used to show as "ready
                 to create": `recording` is already false while the last piece of
                 audio is still being written and has no segment yet, so Create
                 landing here posted a transcript that stopped early with nothing
                 saying so. */
              <div className={styles.teamPickNote}>The end of this recording is still being written to this device — it takes a moment, and creating the meeting before it lands would release the audio for the last piece of it.</div>
            ) : unresolved > 0 ? (
              <div className={styles.teamPickNote}>
                {unresolved === 1 ? "1 segment is still being transcribed" : `${unresolved} segments are still being transcribed`} — creating the meeting now states {unresolved === 1 ? "it" : "them"} as gaps with their time ranges.
              </div>
            ) : null}
            <div className={styles.modalActions} style={{ justifyContent: "space-between" }}>
              <div className={styles.recordActions}><button type="button" className={styles.track} onClick={() => (cap.recording ? capture.stop() : void capture.record())} disabled={cap.busy === "transcribe"}>{cap.recording ? "■ Stop recording" : cap.busy === "transcribe" ? "Transcribing…" : <><Microphone size={13} weight="fill" /> Record</>}</button>{cap.recording ? <button type="button" className={styles.track} onClick={() => capture.togglePause()}>{cap.paused ? "▶ Resume" : "Ⅱ Pause"}</button> : null}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className={styles.track} onClick={() => { if (cap.recording) capture.stop(); capture.closeDialog(); }}>Cancel</button>
                <button type="button" className={styles.newBtn} onClick={() => void capture.submit()} disabled={cap.busy === "create" || cap.recording || cap.settling}>
                  {cap.busy === "create" ? "Creating…" : cap.settling ? "Saving the recording…" : "Create + summarize"}
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
