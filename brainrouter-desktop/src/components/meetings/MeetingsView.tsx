import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import {
  DEFAULT_MEETING_CHUNK_MS,
  DEFAULT_MEETING_UNIT_MS,
  EMPTY_TRANSCRIPT_FOLD,
  beginTranscriptFold,
  capturePhaseNote,
  foldTranscript,
  formatCaptureTimestamp,
  reconcileCaptureDraft,
  transcriptSoFar,
  unsettledSegments,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
  type MeetingDrainPhase,
  type MeetingLiveUtterance,
  type MeetingRecoverySummary,
  type TranscriptFold,
} from "@kinqs/brainrouter-core/meetings";
import "./meetings.css";
import { MeetingTracksView } from "./MeetingTracksView.js";
import { SharePopover } from "./SharePopover.js";
import { TeamsView } from "./TeamsView.js";
import { createMeetingCaptureOps, type MeetingCaptureProgress, type MeetingCaptureWriter, type MeetingTranscriptionStatus } from "./captureOps.js";
import { MeetingCaptureRecorder } from "./captureRecorder.js";
import { NO_CAPTURE_HOLD, captureInFlight, captureInHand, createCaptureHold, createComposeLife, prepareSubmission, type MeetingCaptureHold } from "./composeSubmit.js";
import { createLegacyDraftMigration, type LegacyDraftMigration } from "./legacyDraft.js";
import { createTeamsOps } from "./teamsOps.js";
import { useActiveOrg } from "../../lib/orgContext.js";
import { bridgeQuery } from "../../lib/bridgeQuery.js";
import { captureToPlanner, createAndCite, meetingUri } from "../../lib/workspace/crossMode.js";
import {
  MEETING_SCOPES,
  SCOPE_LABEL,
  type CreateMeetingInput,
  type MeetingActionItem,
  type MeetingDetail,
  type MeetingListItem,
  type MeetingScope,
  type MeetingTranscriptLine,
  type MeetingsOps,
} from "./types.js";

const BADGE_CLASS: Record<MeetingScope, string> = { private: "mv-b-private", team: "mv-b-team", org: "mv-b-org", public: "mv-b-public" };
const STATUS_LABEL: Record<MeetingDetail["summaryStatus"], string> = { queued: "Queued", processing: "Summarizing", ready: "Ready", failed: "Summary failed" };
/**
 * ADR-035 D3 — the body limit belongs to IMPORT, and only to import.
 *
 * `importAudio` really does post one file, so refusing a 41 MB one here is a
 * kinder version of the 413 the endpoint would answer with. A CAPTURE is never
 * posted whole any more — the host queue sends one ~20 s segment at a time — so
 * applying this to a recording would have refused every meeting longer than
 * about forty minutes for a reason that had stopped being true, while the
 * recovery card went on offering to transcribe it.
 */
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/** Recovery offers say how much audio is on disk, so "it is still there" is a number and not a promise. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;
}

function minutes(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function ScopeBadge({ scope }: { scope: MeetingScope }): ReactElement {
  return <span className={`mv-badge ${BADGE_CLASS[scope]}`}>{scope === "org" ? "Org" : SCOPE_LABEL[scope]}</span>;
}

function initials(handle: string): string {
  const parts = handle.replace(/@.*/, "").split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

export function MeetingsView({ ops, onCaptureChange }: { ops: MeetingsOps; onCaptureChange?: (active: boolean) => void }): ReactElement {
  const teamsOps = useMemo(() => createTeamsOps(), []);
  const [mode, setMode] = useState<"meetings" | "tracked" | "teams">("meetings");
  const [teamRevision, setTeamRevision] = useState(0);
  // ADR-019 Phase 2 — the org context comes from the app-wide workspace switcher
  // (activity bar), not a per-view picker. Meetings, their Track board, and team
  // sharing are all org-scoped and follow it. scopedOrgId is already guarded to
  // orgs the account was actually shown.
  const { activeOrgId, activeContext, scopedOrgId } = useActiveOrg();
  const [items, setItems] = useState<MeetingListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [transcript, setTranscript] = useState<MeetingTranscriptLine[]>([]);
  const [transcriptNext, setTranscriptNext] = useState<string | null>(null);
  const [transcriptTotal, setTranscriptTotal] = useState(0);
  const [composing, setComposing] = useState(false);
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<MeetingScope | "all">("all");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draftSummary, setDraftSummary] = useState("");
  const [copied, setCopied] = useState(false);
  // ADR-035 D2 — the recovery offer has to be where the user LANDS after a
  // crash, which is the library, not the compose form they never opened. This is
  // only the count and the way in; the offer itself lives in the compose view
  // beside the transcript it fills.
  const capture = useMemo(() => createMeetingCaptureOps(), []);
  /**
   * D6 — the `localStorage` draft is emptied HERE, not in the compose form.
   *
   * It used to be read on the composer's first render, so a user who upgraded
   * and only ever read old summaries kept the previous build's draft — including
   * every live segment D4 folded into it — for as long as they never pressed
   * "+ New". This view mounts whenever anyone looks at meetings at all, which is
   * the earliest point that is still inside the feature. The migration is handed
   * to the composer so its restore reads the protected file AFTER the hand-over,
   * and so anything that could not be handed over is still offered back.
   *
   * BUILT here and RUN below, because building one does nothing and running one
   * reads-and-REMOVES `localStorage`. React may call this function twice for a
   * single commit and keep the second result — StrictMode's double render does
   * exactly that on every mount in `vite dev` — and the second run of a
   * read-and-remove finds an empty store and answers `null`. Starting it from
   * this memo therefore took the draft out of `localStorage` and then discarded
   * the one promise still holding it: an old preload or a failed write lost the
   * words, and the composer's restore below awaited a hand-over that had never
   * happened. A read-and-remove is not a computation and does not belong in a
   * render — and it is the same double invoke, one layer up, that made
   * `createComposeLife` a counter rather than a latch.
   */
  const legacyDraft = useMemo(() => createLegacyDraftMigration(capture), [capture]);
  useEffect(() => { void legacyDraft.run(); }, [legacyDraft]);
  /**
   * A1/F1 — the capture the compose form is holding, as a fact about the APP
   * rather than about whether that form happens to be on screen.
   *
   * Held here because four ordinary clicks — Cancel, opening a meeting from the
   * library, the Track/Teams tabs, the workspace switcher — used to unmount the
   * composer and take the live recorder with it, ending the meeting with nothing
   * on screen to say so. The composer now stays mounted for as long as a capture
   * is open, and this is also what puts the indicator below in front of the user.
   *
   * It carries the capture's ID and not merely a flag because of F1: the library
   * asked the store for unfinished recordings and got back the one being made
   * right now — `isResumableSession` deliberately does not narrow on `recording`
   * (a clean quit leaves audio that never transcribed) — so the CTA offered to
   * "transcribe it, or delete it" at the same moment the bar above said a meeting
   * was being recorded, and its Delete had neither a confirmation nor a guard.
   */
  const [hold, setHold] = useState<MeetingCaptureHold>(NO_CAPTURE_HOLD);
  const recording = hold.recording;
  // A1/F3 — the composer stays mounted for as long as the capture is still being
  // written to, which is NOT only while the microphone is open: Stop returns
  // before the final chunk has reached the disk.
  const capturing = captureInFlight(hold);
  const [interrupted, setInterrupted] = useState(0);
  // ADR-028 — a recovery query that FAILED is not "nothing to recover". Both
  // read the same on screen and only one of them means the audio is gone, so a
  // failure says so instead of rendering a library with no offer in it.
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  // D6 — meetings that were created but whose audio could not be released. The
  // meeting succeeded; the bytes are still here. Kept apart from `interrupted`
  // because "this could not be deleted" and "this recording was interrupted"
  // are different facts, and only the first one is true of it.
  const [retained, setRetained] = useState<readonly { sessionId: string; message: string }[]>([]);
  // Joined into a string so the effect below re-runs when the SET changes rather
  // than on every render, which an array identity would cause.
  const retainedKey = retained.map((row) => row.sessionId).join(" ");
  // Invariant 5 — EVERY capture the compose form still holds, not merely the one
  // its live rows are bound to. Joined for the same reason `retainedKey` is: the
  // effect must re-run when the SET changes, and an array identity would run it
  // on every render.
  const heldCaptureKey = hold.inHand.join(" ");
  useEffect(() => {
    let active = true;
    const released = new Set(retainedKey ? retainedKey.split(" ") : []);
    const heldCaptureIds = heldCaptureKey ? heldCaptureKey.split(" ") : [];
    // F1 — the captures in hand are left out. They are unfinished by definition,
    // and the store cannot judge them: only this window knows which sessions its
    // own compose form is still holding.
    void capture.resumable({ orgId: scopedOrgId ?? null }, heldCaptureIds.length ? { exclude: heldCaptureIds } : {})
      .then((rows) => { if (active) { setInterrupted(rows.filter((row) => !released.has(row.sessionId)).length); setRecoveryError(""); } })
      .catch((caught) => { if (active) { setInterrupted(0); setRecoveryError(errorText(caught, "Could not check this device for unfinished recordings.")); } });
    // Re-read when compose closes: a capture recovered or discarded in there is
    // one this banner must stop advertising.
    return () => { active = false; };
  }, [capture, composing, heldCaptureKey, recoveryRevision, retainedKey, scopedOrgId]);
  /**
   * F4 — the fifth click: the activity-bar mode rail.
   *
   * A1 kept the composer mounted through the four clicks INSIDE this view, and
   * the rail still ended the meeting silently, because the shell renders this
   * whole view only while its mode is selected. So the shell is told, and it
   * keeps this view mounted and says where the recording went — the same
   * decision as A1's, one level up. Reported from an effect rather than from
   * each call site so the answer is the state itself and cannot drift from it.
   */
  useEffect(() => { onCaptureChange?.(capturing); }, [capturing, onCaptureChange]);

  const retainAudio = useCallback((notice: { sessionId: string; message: string }) => {
    setRetained((rows) => [...rows.filter((row) => row.sessionId !== notice.sessionId), notice]);
  }, []);

  /** The retry for a `finalize` that failed after the meeting itself was created. */
  const releaseRetained = useCallback(async (sessionId: string) => {
    try {
      await capture.finalize(sessionId);
      setRetained((rows) => rows.filter((row) => row.sessionId !== sessionId));
      setRecoveryRevision((value) => value + 1);
    } catch (caught) {
      setRetained((rows) => rows.map((row) => row.sessionId === sessionId
        ? { ...row, message: `That meeting's recording is still on this device — ${errorText(caught, "the capture store refused the delete.")}` }
        : row));
    }
  }, [capture]);

  const refreshList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await ops.listPage({ limit: 50 }, scopedOrgId);
      setItems(page.meetings);
      setNextCursor(page.nextCursor);
      setSelectedId((current) => current && page.meetings.some((item) => item.id === current) ? current : page.meetings[0]?.id ?? null);
    } catch (caught) {
      setItems([]);
      setNextCursor(null);
      setSelectedId(null);
      setError(errorText(caught, "Could not load meetings."));
    } finally { setLoading(false); }
  }, [scopedOrgId, ops]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  // Switching workspace (via the activity-bar switcher) re-scopes everything:
  // drop the open meeting/compose and bump the team revision so the share picker
  // refetches the new org's teams. Skips the initial "" → org-id resolution
  // (prev === null) so first paint doesn't flash a reset.
  const prevOrgRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevOrgRef.current;
    prevOrgRef.current = activeOrgId;
    if (prev === null || prev === activeOrgId) return;
    setComposing(false);
    setSelectedId(null);
    setDetail(null);
    setTranscript([]);
    setTeamRevision((value) => value + 1);
  }, [activeOrgId]);

  const loadMoreMeetings = useCallback(async () => {
    if (!nextCursor || busy) return;
    setBusy("more-meetings");
    try {
      const page = await ops.listPage({ cursor: nextCursor, limit: 50 }, scopedOrgId);
      setItems((current) => [...current, ...page.meetings.filter((row) => !current.some((existing) => existing.id === row.id))]);
      setNextCursor(page.nextCursor);
    } catch (caught) { setError(errorText(caught, "Could not load more meetings.")); }
    finally { setBusy(""); }
  }, [scopedOrgId, busy, nextCursor, ops]);

  useEffect(() => {
    if (!selectedId || composing) { setDetail(null); setTranscript([]); return; }
    let active = true;
    const id = selectedId;
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    setTranscript([]);
    setTranscriptNext(null);
    setTranscriptTotal(0);
    setTranscriptLoading(true);
    setEditing(false);
    void ops.overview(id, scopedOrgId).then((overview) => {
      if (active) { setDetail({ ...overview, transcript: [] }); setDraftSummary(overview.summaryMarkdown); }
    }).catch((caught) => { if (active) setDetailError(errorText(caught, "Could not load this meeting.")); })
      .finally(() => { if (active) setDetailLoading(false); });
    void ops.transcriptPage(id, { limit: 100 }, scopedOrgId).then((page) => {
      if (active) { setTranscript(page.segments); setTranscriptNext(page.nextCursor); setTranscriptTotal(page.total); }
    }).catch((caught) => { if (active) setDetailError(errorText(caught, "Could not load the transcript.")); })
      .finally(() => { if (active) setTranscriptLoading(false); });
    return () => { active = false; };
  }, [scopedOrgId, composing, ops, selectedId]);

  useEffect(() => {
    if (!detail || !["queued", "processing"].includes(detail.summaryStatus)) return;
    let active = true;
    const id = detail.id;
    const timer = globalThis.setInterval(() => {
      void ops.overview(id, scopedOrgId).then((overview) => {
        if (!active) return;
        setDetail((current) => current?.id === id ? { ...current, ...overview } : current);
        setItems((list) => list.map((item) => item.id === id ? { ...item, summaryStatus: overview.summaryStatus } : item));
      }).catch(() => undefined);
    }, 3000);
    return () => { active = false; globalThis.clearInterval(timer); };
  }, [scopedOrgId, detail?.id, detail?.summaryStatus, ops]);

  const loadMoreTranscript = useCallback(async () => {
    if (!detail || !transcriptNext || transcriptLoading) return;
    const id = detail.id;
    setTranscriptLoading(true);
    try {
      const page = await ops.transcriptPage(id, { cursor: transcriptNext, limit: 100 }, scopedOrgId);
      if (detail.id === id) setTranscript((current) => [...current, ...page.segments]);
      setTranscriptNext(page.nextCursor);
      setTranscriptTotal(page.total);
    } catch (caught) { setError(errorText(caught, "Could not load more transcript.")); }
    finally { setTranscriptLoading(false); }
  }, [scopedOrgId, detail, ops, transcriptLoading, transcriptNext]);

  const setScope = useCallback(async (scope: MeetingScope, options?: { teamId?: string }) => {
    if (!detail || busy) return;
    setBusy("share");
    setError("");
    try {
      const share = await ops.setScope(detail.id, scope, options, scopedOrgId);
      setDetail((current) => current ? { ...current, share } : current);
      setItems((list) => list.map((item) => item.id === detail.id ? { ...item, scope } : item));
    } catch (caught) { setError(errorText(caught, "Could not change meeting access.")); }
    finally { setBusy(""); }
  }, [scopedOrgId, busy, detail, ops]);

  const toggleAction = useCallback(async (action: MeetingActionItem) => {
    if (!detail || busy) return;
    const done = !action.done;
    const previous = detail.actionItems;
    setBusy(`action:${action.id}`);
    setDetail({ ...detail, actionItems: previous.map((item) => item.id === action.id ? { ...item, done } : item) });
    setError("");
    try { await ops.toggleAction(detail.id, action.id, done, scopedOrgId); }
    catch (caught) { setDetail((current) => current ? { ...current, actionItems: previous } : current); setError(errorText(caught, "Could not update that action item.")); }
    finally { setBusy(""); }
  }, [scopedOrgId, busy, detail, ops]);

  const toggleTrack = useCallback(async (action: MeetingActionItem) => {
    if (!detail || busy) return;
    const previous = detail.actionItems;
    setBusy(`track:${action.id}`);
    setError("");
    try {
      if (action.trackItemId) {
        await ops.unsendActionFromTrack(detail.id, action.id, scopedOrgId);
        setDetail((current) => current ? { ...current, actionItems: current.actionItems.map((item) => item.id === action.id ? { ...item, trackItemId: undefined } : item) } : current);
      } else {
        const { trackItemId } = await ops.sendActionToTrack(detail.id, action.id, scopedOrgId);
        setDetail((current) => current ? { ...current, actionItems: current.actionItems.map((item) => item.id === action.id ? { ...item, trackItemId } : item) } : current);
      }
    } catch (caught) { setDetail((current) => current ? { ...current, actionItems: previous } : current); setError(errorText(caught, "Could not update Meeting Track.")); }
    finally { setBusy(""); }
  }, [scopedOrgId, busy, detail, ops]);

  const regenerate = useCallback(async () => {
    if (!detail || busy) return;
    setBusy("regenerate");
    setError("");
    try { const updated = await ops.regenerateSummary(detail.id, scopedOrgId); setDetail(updated); setDraftSummary(updated.summaryMarkdown); }
    catch (caught) { setError(errorText(caught, "Could not regenerate this summary.")); }
    finally { setBusy(""); }
  }, [scopedOrgId, busy, detail, ops]);

  const saveSummary = useCallback(async () => {
    if (!detail || busy) return;
    setBusy("save-summary");
    setError("");
    try { const updated = await ops.updateSummary(detail.id, draftSummary, scopedOrgId); setDetail(updated); setEditing(false); }
    catch (caught) { setError(errorText(caught, "Could not save this summary.")); }
    finally { setBusy(""); }
  }, [scopedOrgId, busy, detail, draftSummary, ops]);

  /**
   * ADR-029 C2 — Meetings → Notes: the summary becomes a page, TRANSCRIPT
   * REFERENCED RATHER THAN COPIED.
   *
   * The page carries the summary and a reference back to the meeting, so the
   * transcript stays where it is and stays the one copy. Copying it would
   * produce a second version that drifts the moment the summary is regenerated
   * — the quietly-wrong document A3 argues against.
   */
  const summaryToNotes = useCallback(async () => {
    if (!detail || busy) return;
    setBusy("to-notes");
    setError("");
    try {
      const page = await createAndCite({
        mode: "notes", kind: "block", title: detail.title,
        from: meetingUri(detail.id), fields: { kind: "page" },
      });
      if (!page.ok) { setError(page.error); return; }
      const parentId = page.uri.replace("brainrouter://notes/block/", "");
      if (detail.summaryMarkdown.trim()) {
        await bridgeQuery("notes-create", { parentId, text: detail.summaryMarkdown, kind: "paragraph" });
      }
    } catch (caught) { setError(errorText(caught, "Could not save this summary to notes.")); }
    finally { setBusy(""); }
  }, [busy, detail]);

  // Owner-only hard delete — the server also removes the transcript source and
  // the recallable summary record, so the meeting doesn't linger in recall.
  const deleteMeeting = useCallback(async () => {
    if (!detail?.canEdit || busy) return;
    if (!globalThis.confirm?.(`Delete "${detail.title}"? Its transcript, notes and recallable summary are removed permanently.`)) return;
    setBusy("delete");
    setError("");
    try {
      await ops.deleteMeeting(detail.id, scopedOrgId);
      setSelectedId(null);
      setDetail(null);
      await refreshList();
    } catch (caught) { setError(errorText(caught, "Could not delete this meeting.")); }
    finally { setBusy(""); }
  }, [scopedOrgId, busy, detail, ops, refreshList]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => (scopeFilter === "all" || item.scope === scopeFilter) && (!needle || item.title.toLowerCase().includes(needle)));
  }, [items, query, scopeFilter]);

  /**
   * A1 — whether the person can actually SEE the compose form, which is not the
   * same question as whether it is mounted.
   *
   * The composer stays mounted for as long as a recording is running, because
   * unmounting it is what used to end the meeting. So "is it on screen" is what
   * decides whether the recording needs an indicator pointing back to it, and
   * the Track/Teams tabs make that a different answer from `composing` alone.
   */
  const composeVisible = composing && mode === "meetings";

  return (
    <div className="mv-shell">
      <div className="mv-tabs" role="tablist" aria-label="Meetings sections">
        {(["meetings", "tracked", "teams"] as const).map((tab) => <button type="button" key={tab} role="tab" aria-selected={mode === tab} className={`mv-tab${mode === tab ? " mv-on" : ""}`} onClick={() => setMode(tab)}>{tab === "tracked" ? "Track" : tab[0].toUpperCase() + tab.slice(1)}</button>)}
        {mode !== "teams" && activeContext ? <span className="mv-orgctx-label" title="Workspace — switch from the activity bar">{activeContext.isPersonal ? `${activeContext.name} · Personal workspace` : activeContext.name}</span> : null}
      </div>
      {/* A1/ADR-028 — the recording keeps going when the user navigates, so
          something has to say so from wherever they went. It sits ABOVE the tab
          switch on purpose: the Track and Teams tabs replace everything below
          this line, and an indicator inside the part that gets replaced is one
          the user cannot see from three of the four places they can go. */}
      {capturing && !composeVisible ? (
        <div className="mv-recbar" role="status">
          <span className="mv-recbar-dot" aria-hidden="true" />
          <span>{recording ? "A meeting is being recorded. Its audio is being saved to this device." : "The last part of a recording is still being saved to this device."}</span>
          <button type="button" onClick={() => { setMode("meetings"); setSelectedId(null); setComposing(true); }}>Back to the recording</button>
        </div>
      ) : null}
      {mode === "tracked" ? <MeetingTracksView ops={ops} orgId={scopedOrgId} /> : null}
      {mode === "teams" ? <TeamsView ops={teamsOps} onChanged={() => setTeamRevision((value) => value + 1)} /> : null}
      {mode === "meetings" || capturing ? (
        // Hidden rather than unmounted while another tab is open, and only while
        // a capture is open: the live recorder, the folded transcript and the
        // phase all live in the compose form below, and React discards every one
        // of them on unmount.
        <div className="mv-root" {...(mode === "meetings" ? {} : { style: { display: "none" } })}>
          <aside className={`mv-col${selectedId || composing ? " mv-col-has-selection" : ""}`}>
            <div className="mv-col-head"><div><span className="mv-eyebrow">Library</span><h2>Meetings <span>{items.length}</span></h2></div><button type="button" className="mv-newbtn" onClick={() => { setComposing(true); setSelectedId(null); }}>+ New</button></div>
            <label className="mv-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search meetings" aria-label="Search meetings" />{query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search">×</button> : null}</label>
            <div className="mv-scope-filters" role="group" aria-label="Filter meeting visibility">{(["all", ...MEETING_SCOPES] as const).map((scope) => <button type="button" key={scope} className={scopeFilter === scope ? "mv-on" : ""} aria-pressed={scopeFilter === scope} onClick={() => setScopeFilter(scope)}>{scope === "org" ? "Org" : scope[0].toUpperCase() + scope.slice(1)}</button>)}</div>
            {error ? <div className="mv-list-error" role="alert">{error}<button type="button" onClick={() => void refreshList()}>Retry</button></div> : null}
            {retained.map((row) => <div className="mv-list-error" role="alert" key={row.sessionId}>{row.message}<button type="button" onClick={() => void releaseRetained(row.sessionId)}>Delete the audio</button></div>)}
            {recoveryError ? <div className="mv-list-error" role="alert">{recoveryError}<button type="button" onClick={() => setRecoveryRevision((value) => value + 1)}>Check again</button></div> : null}
            {/* "Unfinished", not "interrupted": a recording that was stopped
                deliberately and never turned into a meeting lands here too, and
                calling that an interruption tells the user something went wrong
                when what went wrong was nothing. */}
            {interrupted > 0 && !composing ? <button type="button" className="mv-recovery-cta" onClick={() => { setComposing(true); setSelectedId(null); }}><strong>{interrupted === 1 ? "1 unfinished recording" : `${interrupted} unfinished recordings`}</strong><small>The audio is still on this device — transcribe it, or delete it</small></button> : null}
            <div className="mv-items">
              {filtered.map((item) => <button type="button" key={item.id} className={`mv-item${!composing && item.id === selectedId ? " mv-on" : ""}`} onClick={() => { setComposing(false); setSelectedId(item.id); }} aria-pressed={!composing && item.id === selectedId}><span className="mv-item-t">{item.title}</span><span className="mv-item-m"><span className="mv-item-d">{item.date}</span><span className={`mv-summary-dot mv-summary-${item.summaryStatus}`} title={`Summary ${item.summaryStatus}`} /><ScopeBadge scope={item.scope} />{!item.canEdit ? <span className="mv-shared-readonly">Shared</span> : null}</span></button>)}
              {!filtered.length ? <div className="mv-state">{loading ? "Loading meetings…" : items.length ? "No meetings match these filters." : "No meetings yet. Record, import audio, or paste a transcript to begin."}</div> : null}
            </div>
            {nextCursor ? <button type="button" className="mv-load-more" disabled={busy === "more-meetings"} onClick={() => void loadMoreMeetings()}>{busy === "more-meetings" ? "Loading…" : "Load more meetings"}</button> : null}
          </aside>

          {/* A1 — mounted while composing OR while a capture is open, and only
              HIDDEN in between. `display: contents` so a shown composer
              lays out exactly as it did when it was a direct child; the wrapper
              exists solely to have something to hide. Unmounting it is what
              stopped the microphone, dropped the live transcript, and left the
              session claiming to be recording. */}
          {composing || capturing ? (
            <div style={{ display: composeVisible ? "contents" : "none" }}>
              <NewMeeting ops={ops} orgId={scopedOrgId} legacyDraft={legacyDraft} onAudioRetained={retainAudio} onCaptureHold={setHold} onCancel={() => { setComposing(false); void refreshList(); }} onCreated={async (id) => { await refreshList(); setComposing(false); setSelectedId(id); }} />
            </div>
          ) : null}
          {composing ? null : detail ? (
            <main className="mv-detail">
              <button type="button" className="mv-mobile-back" onClick={() => setSelectedId(null)}>← Meetings</button>
              {error ? <div className="mv-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}
              <header className="mv-dhead">
                <div className="mv-dhead-row"><div className="mv-title-block"><div className="mv-title-status"><span className={`mv-summary-dot mv-summary-${detail.summaryStatus}`} />{STATUS_LABEL[detail.summaryStatus]}</div><h3>{detail.title}</h3><div className="mv-att"><span className="mv-av">{detail.attendees.slice(0, 4).map((attendee) => <span key={attendee}>{initials(attendee)}</span>)}</span>{detail.attendees.length ? detail.attendees.join(", ") : "No attendees recorded"}</div></div><div className="mv-hactions">{detail.canEdit ? <SharePopover share={detail.share} busy={busy === "share"} teamsOps={teamsOps} teamRevision={teamRevision} context={activeContext} onError={setError} onSetScope={(scope, options) => void setScope(scope, options)} /> : <span className="mv-shared-readonly">Shared with you · read only</span>}{detail.model ? <span className="mv-modelchip">{detail.model.label}{detail.model.effort ? <> · <b>{detail.model.effort}</b></> : null}</span> : null}{detail.canEdit ? <button type="button" className="mv-danger-btn" disabled={busy === "delete"} onClick={() => void deleteMeeting()}>{busy === "delete" ? "Deleting…" : "Delete"}</button> : null}</div></div>
                <div className="mv-metastrip"><span className="mv-chip">{detail.status || "Captured"}</span><span className="mv-chip">{detail.date}</span>{detail.durationMin ? <span className="mv-chip">{detail.durationMin} min</span> : null}{detail.wordCount ? <span className="mv-chip">{detail.wordCount.toLocaleString()} words</span> : null}</div>
              </header>
              <div className="mv-dbody">
                <div className="mv-colL">
                  {detail.summaryStatus === "failed" ? <div className="mv-summary-failed"><strong>Summary generation failed</strong><span>{detail.summaryError || (detail.canEdit ? "The transcript is preserved. Try generating the summary again." : "The transcript is preserved. The owner can generate the summary again.")}</span>{detail.canEdit ? <button type="button" className="mv-secondary" onClick={() => void regenerate()}>Try again</button> : null}</div> : null}
                  <section className="mv-card"><div className="mv-card-lab"><span>Summary</span><div className="mv-cardacts">{editing ? <><button type="button" className="mv-ghost" onClick={() => { setEditing(false); setDraftSummary(detail.summaryMarkdown); }}>Cancel</button><button type="button" className="mv-ghost mv-ghost-strong" disabled={busy === "save-summary"} onClick={() => void saveSummary()}>{busy === "save-summary" ? "Saving…" : "Save"}</button></> : <>{detail.canEdit ? <><button type="button" className="mv-ghost" disabled={busy === "regenerate"} onClick={() => void regenerate()}>{busy === "regenerate" ? "Generating…" : "Regenerate"}</button><button type="button" className="mv-ghost" onClick={() => { setDraftSummary(detail.summaryMarkdown); setEditing(true); }}>Edit</button></> : null}<button type="button" className="mv-ghost" onClick={() => { void navigator.clipboard?.writeText(detail.summaryMarkdown); setCopied(true); globalThis.setTimeout(() => setCopied(false), 1400); }}>{copied ? "Copied" : "Copy"}</button><button type="button" className="mv-ghost" title="Open the summary as a note page that references this meeting" disabled={busy === "to-notes"} onClick={() => void summaryToNotes()}>{busy === "to-notes" ? "Saving…" : "To notes"}</button></>}</div></div>{editing ? <textarea className="mv-summary-editor" value={draftSummary} onChange={(event) => setDraftSummary(event.target.value)} aria-label="Meeting summary" /> : detail.summaryStatus === "queued" || detail.summaryStatus === "processing" ? <div className="mv-processing"><span />Generating a recallable summary. You can leave this page.</div> : detail.summaryMarkdown ? <SummaryBody markdown={detail.summaryMarkdown} /> : <div className="mv-state">No summary is available yet.</div>}</section>
                  <section className="mv-card"><div className="mv-card-lab"><span>Action items</span><span>{detail.actionItems.length}</span></div>{detail.actionItems.length ? detail.actionItems.map((action) => <div className="mv-ai" key={action.id}><button type="button" className={`mv-cbox${action.done ? " mv-done" : ""}`} disabled={!detail.canEdit || busy === `action:${action.id}`} aria-label={action.done ? "Mark not done" : "Mark done"} onClick={() => void toggleAction(action)}>✓</button><div className="mv-txt"><span className={action.done ? "mv-action-done" : ""}>{action.title}</span>{action.assignee ? <small>→ {action.assignee}</small> : null}</div>{detail.canEdit ? <button type="button" className={`mv-totrack${action.trackItemId ? " mv-linked" : ""}`} disabled={busy === `track:${action.id}`} onClick={() => void toggleTrack(action)}>{busy === `track:${action.id}` ? "Updating…" : action.trackItemId ? "In Track ✓" : "Track ↗"}</button> : null}{detail.canEdit ? <button type="button" className="mv-totrack" title="Add to your planner, citing this meeting" onClick={() => void captureToPlanner(action.title, meetingUri(detail.id))}>Plan ↗</button> : null}</div>) : <div className="mv-state mv-state-compact">No action items were detected.</div>}</section>
                </div>
                <section className="mv-tpanel"><div className="mv-card-lab"><span>Transcript</span><span>{transcript.length}{transcriptTotal > transcript.length ? ` of ${transcriptTotal}` : ""}</span></div>{transcriptLoading && transcript.length === 0 ? <div className="mv-state">Loading transcript…</div> : transcript.length ? <TranscriptLines segments={transcript} /> : <div className="mv-state">No transcript segments are available.</div>}{transcriptNext ? <button type="button" className="mv-load-more" disabled={transcriptLoading} onClick={() => void loadMoreTranscript()}>{transcriptLoading ? "Loading…" : "Load more transcript"}</button> : null}</section>
              </div>
            </main>
          ) : <main className="mv-detail">{detailLoading ? <div className="mv-state mv-state-center">Loading meeting…</div> : detailError ? <div className="mv-detail-error" role="alert"><strong>Could not open this meeting</strong><span>{detailError}</span><button type="button" className="mv-secondary" onClick={() => { const id = selectedId; setSelectedId(null); globalThis.queueMicrotask(() => setSelectedId(id)); }}>Retry</button></div> : <div className="mv-state mv-state-center">Select a meeting, or start a new one.</div>}</main>}
        </div>
      ) : null}
    </div>
  );
}

function TranscriptLines({ segments }: { segments: MeetingTranscriptLine[] }): ReactElement {
  const [scrollTop, setScrollTop] = useState(0);
  const rowHeight = 58;
  if (segments.length <= 40) return <div role="list">{segments.map((line, index) => <TranscriptLine key={line.ordinal ?? index} line={line} />)}</div>;
  const height = 520;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
  const end = Math.min(segments.length, start + Math.ceil(height / rowHeight) + 10);
  return <div className="mv-transcript-viewport" style={{ height }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} role="list" aria-label={`${segments.length} loaded transcript segments`}><div style={{ height: segments.length * rowHeight, position: "relative" }}><div style={{ position: "absolute", top: start * rowHeight, left: 0, right: 0 }}>{segments.slice(start, end).map((line, offset) => <TranscriptLine key={line.ordinal ?? start + offset} line={line} />)}</div></div></div>;
}

function TranscriptLine({ line }: { line: MeetingTranscriptLine }): ReactElement {
  return <div className="mv-tr-line" role="listitem">{line.at ? <span className="mv-ts">{line.at}</span> : null}{line.speaker ? <span className="mv-sp">{line.speaker}</span> : null}<span className="mv-tx">{line.text}</span></div>;
}

function SummaryBody({ markdown }: { markdown: string }): ReactElement {
  const blocks: ReactElement[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { blocks.push(<ul key={`list-${blocks.length}`}>{list.map((line, index) => <li key={index}>{line}</li>)}</ul>); list = []; } };
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith("- ")) { list.push(line.slice(2)); continue; }
    flush();
    if (/^#{1,3} /.test(line)) blocks.push(<h4 key={blocks.length}>{line.replace(/^#{1,3} /, "")}</h4>);
    else blocks.push(<p key={blocks.length}>{line}</p>);
  }
  flush();
  return <div className="mv-summary-body">{blocks}</div>;
}

/**
 * ADR-035 D4/D5 — the live state of a capture's transcription.
 *
 * The transcribed TEXT is not repeated here: it lands in the editable transcript
 * box below, where a user can correct a name while the meeting is still running,
 * which was §1's fourth failure ("the first evidence that capture succeeded
 * arrives after the only moment when it could have been fixed"). What this panel
 * carries is the thing the box cannot say — which segments are settled, which
 * are still in flight, and which are gaps.
 *
 * ADR-028 is the reason each row says what it actually is rather than showing
 * one spinner for the meeting: "Transcribing…" on a segment that failed twenty
 * minutes ago is the failure this ADR is trying to end, wearing a spinner. So a
 * queued segment says queued, an in-flight one says transcribing, and a failed
 * one prints the shared gap marker with its time range and offers the retry that
 * reads the audio still on disk.
 *
 * The rows alone still cannot say one thing, which is why `phase` is here: under
 * D7 an outage leaves every queued segment at `pending` with nothing spent, so a
 * queue waiting on a dead endpoint renders identically to one that is working.
 * That difference exists only in the queue's drain phase, so the host pushes it
 * and this panel prints it.
 *
 * The SENTENCE that comes out of those states is `capturePhaseNote`'s, in core.
 * It was written twice — once here and once on the dashboard — and the two had
 * already drifted: one said these segments "transcribe when it comes back" and
 * the other "WILL transcribe when it comes back". Two hosts, one promise, two
 * wordings is how the second host becomes the worse one (D1b), so the wording
 * and the precedence between the states now live in one tested place and this
 * panel only counts the rows it is showing.
 *
 * D10 adds two things above those rows, and both are about honesty rather than
 * decoration:
 *
 * - **The utterances still being spoken.** They are marked PROVISIONAL and are
 *   not in the compose box, because they are still being rewritten. When one is
 *   committed it leaves this list and arrives in the box as settled text — the
 *   same `transcriptFold` rule every other segment goes through, which is what
 *   makes an edit safe from a late revision (D4).
 * - **Which strategy is running, and why.** A meeting transcribed in segments
 *   because live transcription was refused must not look like one that never
 *   asked (golden rule 23), so main's sentence is printed here rather than
 *   inferred from the absence of live rows.
 */
function LiveTranscript({ session, phase, transcription, utterances, retrying, onRetry }: { session: MeetingCaptureSession; phase: MeetingDrainPhase | null; transcription: MeetingTranscriptionStatus | null; utterances: readonly MeetingLiveUtterance[]; retrying: number | null; onRetry(index: number): void }): ReactElement {
  const entries = transcriptSoFar(session);
  const settled = entries.filter((entry) => entry.kind === "settled").length;
  const provisional = entries.filter((entry) => entry.kind === "provisional").length;
  const gaps = entries.filter((entry) => entry.kind === "gap").length;
  const note = capturePhaseNote(session, phase, { gaps, provisional });
  // The badge is the STRATEGY, not the socket. A connection being picked up
  // again is still a meeting on the live path — its sentence says so — and
  // flipping the badge to "Segments" for the seconds of a reconnect would tell a
  // person their meeting changed strategy when it did not.
  const streaming = transcription?.mode === "streaming";
  return (
    <section className="mv-live">
      <div className="mv-card-lab">
        <span>Live transcript{transcription ? <em className={`mv-live-mode mv-live-mode-${streaming ? "streaming" : "segmented"}`}>{streaming ? "Live" : "Segments"}</em> : null}</span>
        <span>{settled} of {entries.length} transcribed{gaps ? ` · ${gaps} gap${gaps === 1 ? "" : "s"}` : ""}</span>
      </div>
      {utterances.length ? (
        <div className="mv-live-speech" role="status" aria-live="polite">
          {utterances.map((utterance) => (
            <p className={`mv-live-utterance mv-live-utterance-${utterance.state}`} key={utterance.utteranceId}>
              <span className="mv-live-at">{formatCaptureTimestamp(utterance.startMs)}</span>
              <span className="mv-live-words">{utterance.text}</span>
              <small>{utterance.state === "partial" ? "Still being spoken" : "Not saved yet"}</small>
            </p>
          ))}
        </div>
      ) : null}
      {entries.length ? (
        <div className="mv-live-rows" role="list">
          {entries.map((entry) => (
            <div className={`mv-live-row mv-live-${entry.kind}`} role="listitem" key={entry.index}>
              <span className="mv-live-at">{formatCaptureTimestamp(entry.startMs)}–{formatCaptureTimestamp(entry.endMs)}</span>
              {entry.kind === "settled" ? <span className="mv-live-state">Transcribed</span>
                : entry.kind === "provisional" ? <span className="mv-live-state">{entry.state === "transcribing" ? "Transcribing…" : "Queued"}</span>
                  : <><span className="mv-live-gap">{entry.text}{entry.failureReason ? <small>{entry.failureReason}</small> : null}</span><button type="button" className="mv-ghost" disabled={retrying === entry.index} onClick={() => onRetry(entry.index)}>{retrying === entry.index ? "Retrying…" : "Retry"}</button></>}
            </div>
          ))}
        </div>
      ) : utterances.length ? null : <p className="mv-live-empty">Audio is saved to this device every {Math.round(DEFAULT_MEETING_CHUNK_MS / 1000)} seconds. The first transcription unit is about {Math.round(DEFAULT_MEETING_UNIT_MS / 1000)} seconds.</p>}
      {transcription?.notice ? <p className={`mv-live-note mv-live-strategy${streaming ? "" : " mv-live-degraded"}`}>{transcription.notice}</p> : null}
      {note ? <p className="mv-live-note">{note}</p> : null}
    </section>
  );
}

/**
 * The compose form, and — while a recording is running — the owner of the live
 * capture.
 *
 * `legacyDraft` is the view's one-time migration out of `localStorage`, awaited
 * rather than repeated here so the protected file is read after the hand-over —
 * `run()` answers with the promise of the view's own run, and a second migration
 * would find the key already gone and answer that nothing was left over. And
 * `onCaptureHold` is what keeps this component mounted through the four
 * clicks that used to unmount it mid-meeting (A1) and what keeps the library's
 * recovery offer from advertising the recording in hand (F1). Everything the
 * recording consists of — the `MediaRecorder`, the fold, the phase, the live
 * rows — is state inside this function, so its lifetime IS the meeting's.
 */
function NewMeeting({ ops, orgId, legacyDraft, onAudioRetained, onCaptureHold, onCreated, onCancel }: { ops: MeetingsOps; orgId?: string; legacyDraft: LegacyDraftMigration; onAudioRetained(notice: { sessionId: string; message: string }): void; onCaptureHold(hold: MeetingCaptureHold): void; onCreated(id: string): Promise<void>; onCancel(): void }): ReactElement {
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [template, setTemplate] = useState<CreateMeetingInput["template"]>("general");
  const [language, setLanguage] = useState("auto");
  /**
   * F1/F3 — the capture this form holds, and the three windows in which it is
   * still being written to. One object rather than a flag per window, because
   * every reader needs a different pair of them and mirrors that can disagree
   * are how the last two of these were reached.
   *
   * This is the RENDERED copy. `holdStore.current` below is the same value one
   * commit earlier, and the store is the only thing that writes either.
   */
  const [hold, setHold] = useState<MeetingCaptureHold>(NO_CAPTURE_HOLD);
  const { recording } = hold;
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // D1 — audio that could not be written down. Deliberately NOT the `error`
  // above: every operation here opens by clearing that one, so routing a chunk
  // failure into it meant pressing Stop erased the only evidence that part of
  // the meeting was never saved. This one is sticky until the user dismisses it
  // or starts a new recording, because it is a fact about the audio rather than
  // about the last thing that was clicked.
  const [captureIssue, setCaptureIssue] = useState("");
  // D1/ADR-028 — the host computed a durability failure, published it, and this
  // is where it stops being dropped. A `persist` that threw means the RECORD is
  // stale on disk: the audio is still here, but the text may never be written
  // down and the live rows can sit at "Transcribing…" for ever. Sticky, like
  // `captureIssue` and for the same reason — it is a fact about the meeting,
  // not about the last thing that was clicked.
  const [recordIssue, setRecordIssue] = useState("");
  const [recovered, setRecovered] = useState(false);
  // D6 — false until the host has answered with the saved draft. The autosave is
  // gated on it: an empty form is indistinguishable from an emptied one, and
  // saving it before the restore lands would delete the draft being restored.
  const [draftLoaded, setDraftLoaded] = useState(false);
  // ADR-035 D4 — the capture this form is watching, as the HOST last persisted
  // it. Never a local guess: everything rendered from it is already on disk.
  const [live, setLive] = useState<MeetingCaptureSession | null>(null);
  // D7 — where the host's queue stopped. Nothing in the session says whether the
  // endpoint is answering, so without this a stalled queue and a working one
  // render the same. Null until the host has drained at least once.
  const [phase, setPhase] = useState<MeetingDrainPhase | null>(null);
  /**
   * D10 — which transcription strategy the host settled on for this capture,
   * and its one sentence. Null until the endpoint has been asked, which is the
   * only honest thing to show before there is an answer.
   */
  const [transcription, setTranscription] = useState<MeetingTranscriptionStatus | null>(null);
  /**
   * D4/D10 — the words still being spoken.
   *
   * Deliberately NOT `transcript`: this is provisional text the endpoint is
   * still revising, and putting it in the editable box would be handing someone
   * a sentence that rewrites itself under the cursor. It is replaced wholesale
   * by each push, because main holds the reduction and this only draws it.
   */
  const [liveSpeech, setLiveSpeech] = useState<readonly MeetingLiveUtterance[]>([]);
  const [retrying, setRetrying] = useState<number | null>(null);
  /**
   * §6 — "the audio up to the kill must be on disk and PLAYABLE".
   *
   * The one place the renderer ever holds meeting audio, and it holds a COPY:
   * the durable bytes stay in main. It is behind a click because reading an
   * hour-long meeting back is a real allocation, and the object URL is revoked
   * whenever another recording is played and on unmount — a leaked one pins the
   * whole recording in the renderer's heap, which is the thing §1 is about.
   */
  const [preview, setPreview] = useState<{ sessionId: string; url: string; missing: number } | null>(null);
  // ADR-035 D2 — captures from a previous run that hold audio and never reached
  // a terminal state. The list is the recovery offer; the shared model decides
  // which sessions qualify and scopes them to the org now in context.
  const [recoveries, setRecoveries] = useState<MeetingRecoverySummary[]>([]);
  // ADR-028 — the offer to resume is this ADR's deliverable, so a query that
  // could not run says so rather than looking like a device with no audio on it.
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  /**
   * D6 — the captures a window is recording into right now, as MAIN says, not
   * as this window remembers.
   *
   * The offer above deliberately leaves these out, which without this would
   * leave a second BrowserWindow showing an empty library while a meeting is
   * plainly being recorded next door. It is also what the destructive controls
   * consult: the hold beside it is this window's own state and reads false about
   * every recording it did not start, and main is the one thing that holds every
   * window of this process and can therefore answer exactly.
   */
  const [writers, setWriters] = useState<readonly MeetingCaptureWriter[]>([]);
  const capture = useMemo(() => createMeetingCaptureOps(), []);
  const captureScope = useMemo<MeetingCaptureScope>(() => ({ orgId: orgId ?? null }), [orgId]);
  const recorderRef = useRef<MeetingCaptureRecorder | null>(null);
  /**
   * The ONE writer of the hold, and the copy that is true right now.
   *
   * `submit`'s guard and the progress subscription both read it synchronously,
   * and both are wrong reading the rendered copy instead: the guard is the last
   * thing between a running recorder and the delete D6 performs, and the
   * subscription is a closure that would otherwise pin the first render's value
   * for the lifetime of the channel. `setHold` is the publish side, so a patch
   * moves both copies or neither — see `createCaptureHold`.
   */
  const holdStore = useMemo(() => createCaptureHold(setHold), []);
  // D4 — the box's current value, mirrored so a segment arriving between renders
  // folds into what the user has typed rather than into a stale snapshot. It is
  // written by every path that changes the box, including the user's keystrokes.
  const transcriptRef = useRef("");
  // D6 — true from the moment the meeting is being created. An autosave from the
  // last keystroke can still be pending when `clearDraft` runs, and a draft
  // rewritten after that clear is the created meeting's own words coming back
  // into the next compose form — the copy this decision exists to remove.
  const draftRetiredRef = useRef(false);
  const foldRef = useRef<TranscriptFold>(EMPTY_TRANSCRIPT_FOLD);
  const liveRef = useRef<MeetingCaptureSession | null>(null);
  // Which life of this form a read-back belongs to. Reading a recording back is
  // a real allocation that takes a moment, and a `setPreview` after unmount is
  // dropped by React — leaving an object URL nothing will ever revoke, pinning a
  // whole meeting in this window's heap. That is §1's defect in miniature, so
  // the URL is only minted while there is still something to revoke it. A life
  // rather than a `useRef(true)` flag because a flag the teardown lowers is a
  // flag nothing raises again — see `createComposeLife`.
  const formLife = useMemo(() => createComposeLife(), []);

  /** The one place the box is written to from a segment — the shared `foldTranscript`. */
  const applySession = useCallback((session: MeetingCaptureSession) => {
    liveRef.current = session;
    setLive(session);
    const folded = foldTranscript(transcriptRef.current, session, foldRef.current);
    if (!folded.changed) return;
    foldRef.current = folded.fold;
    transcriptRef.current = folded.text;
    setTranscript(folded.text);
  }, []);

  const editTranscript = useCallback((value: string) => {
    transcriptRef.current = value;
    setTranscript(value);
  }, []);

  /**
   * The host's push, in full — not just the session.
   *
   * Reading `progress.session` alone was the ADR-028 defect this ADR exists to
   * end: main computes a durability failure, publishes it, preload forwards it,
   * and the surface renders a spinner over it. The phase and the errors are the
   * two things the session cannot say, so they are the two things a handler that
   * only reads the session silently discards.
   */
  const applyProgress = useCallback((progress: MeetingCaptureProgress) => {
    if (progress.phase) setPhase(progress.phase);
    // D10 — only when the push carried them. A persisted-segment push says
    // nothing about the live path, and treating its silence as "no live text"
    // would blink the utterance being spoken off the screen every three seconds.
    if (progress.transcription) setTranscription(progress.transcription);
    if (progress.live) setLiveSpeech(progress.live);
    if (progress.errors?.length) {
      setRecordIssue(`This meeting's record could not be written to this device: ${progress.errors[0]} The audio already captured is still here, but the transcript may stop filling in until that write succeeds.`);
    }
    applySession(progress.session);
  }, [applySession]);

  /**
   * D6 — the draft comes back from the host's protected directory.
   *
   * Asynchronous now, which is why `draftLoaded` exists: the autosave below runs
   * on a timer, and an empty form whose restore had not landed yet would have
   * cleared the very draft it was about to be given.
   */
  useEffect(() => {
    let active = true;
    void (async () => {
      // Awaited FIRST: the view took the old `localStorage` draft out and is
      // putting it in the protected file, so reading the file before that
      // finished would find nothing and then overwrite it with an empty form.
      // It resolves to a draft only when the hand-over could not happen at all,
      // in which case this form is the last place those words exist.
      //
      // `run()` is the view's migration, not a second one: the words are already
      // out of `localStorage` by the time this form exists, so a fresh migration
      // would answer "nothing was left over" for every draft that had nowhere to
      // go — and the 250 ms autosave below would then clear the file over them.
      const pending = await legacyDraft.run();
      const saved = (await capture.readDraft().catch(() => null)) ?? pending;
      if (!active) return;
      if (saved?.title) setTitle(saved.title);
      if (saved?.transcript) editTranscript(saved.transcript);
      if (saved?.template) setTemplate(saved.template);
      if (saved?.language) setLanguage(saved.language);
      setRecovered(Boolean(saved));
      setDraftLoaded(true);
    })();
    return () => { active = false; };
  }, [capture, editTranscript, legacyDraft]);
  // D4 — the host pushes every persisted change. Subscribing here (rather than
  // polling) is what lets a segment appear the moment it is durable, and the
  // filter is by capture id because main broadcasts to every window.
  useEffect(() => capture.onProgress((progress) => {
    if (progress.sessionId !== holdStore.current.sessionId) return;
    applyProgress(progress);
  }), [applyProgress, capture]);
  // The object URL is a handle on a whole recording held in this window's heap,
  // so it is released the moment another one replaces it or the form closes.
  useEffect(() => {
    if (!preview) return undefined;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);
  /**
   * D6 — the autosave, and what it saves: the compose box, whole.
   *
   * It used to save only `reconcileCaptureDraft(...).retained` — the words no
   * segment contributed — to keep the transcript out of `localStorage`. The
   * draft is in the host's `0600` file now, beside the audio it is a draft of,
   * so that reason is gone; what was left was a strip that CORRUPTED recovery,
   * because the box and the record then disagreed about what the box contained.
   * Restoring a stripped draft and reconciling it against the same session gave
   * four different wrong answers — a hand edit came back doubled, a deletion
   * came back undone, a note moved to the top, and a line that happened to match
   * a later segment silently swallowed the two minutes before it, with no gap
   * marker to say anything had gone.
   *
   * The reconciliation is still exactly right where `adoptCapture` uses it: over
   * a box whose contents are what they claim to be. `retained` is an in-memory
   * recompose base, never a thing to persist and read back.
   */
  useEffect(() => {
    if (!draftLoaded) return undefined;
    const timer = globalThis.setTimeout(() => {
      if (draftRetiredRef.current) return;
      const write = title || transcript
        ? capture.writeDraft({ title, transcript, ...(template ? { template } : {}), language })
        : capture.clearDraft();
      // Not surfaced: this runs on a keystroke timer, so a banner here would
      // repeat per character and bury the durability warnings that matter. The
      // audio is unaffected either way — it is already on disk.
      void write.catch(() => undefined);
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [capture, draftLoaded, language, template, title, transcript]);
  // A1/F1 — the parent keeps this form mounted for as long as a capture is
  // open, shows the way back to it, and leaves the capture in hand out of the
  // recovery offer. Reported from an effect rather than from each call site so
  // the answer is the state itself and cannot drift from it.
  useEffect(() => { onCaptureHold(hold); }, [hold, onCaptureHold]);
  // …and released when this form really does go, so the library stops excluding
  // a capture nobody is holding any more. Its own effect, so it runs ONLY on
  // unmount: clearing and re-reporting on every change would blink an offer for
  // the live recording back on between the two.
  useEffect(() => () => onCaptureHold(NO_CAPTURE_HOLD), [onCaptureHold]);
  /**
   * A1 — the unmount, which now only happens when the meetings view itself goes
   * away, and CLOSES the recording rather than abandoning it.
   *
   * `dispose` released the microphone and never told the store, so the session
   * stayed `status: "recording"` and the next launch called the user's own
   * navigation an interrupted recording. `stop` writes the last chunk, marks the
   * capture stopped, and leaves the host's queue draining what is on disk (D3) —
   * so what the user finds when they come back is a finished recording waiting
   * to be transcribed, which is what actually happened.
   *
   * G1 — and it reaches a recording that has not STARTED yet, which is the
   * defect this line looked like it was already covering. `startRecording` parks
   * the recorder here before its first await, and `stop` cancels the attempt, so
   * leaving during the microphone prompt ends with nothing running and nothing
   * claimed instead of a recorder feeding a view that is gone.
   */
  useEffect(() => () => {
    formLife.retire();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    void recorder?.stop();
  }, [formLife]);
  useEffect(() => {
    let active = true;
    // F1 — never the capture in hand. It is unfinished by definition, offering
    // it back beside its own "Stop recording" button is nonsense, and its
    // "Delete audio" deletes the directory the recorder is appending to.
    //
    // F1/D6 — the `exclude` is belt-and-braces now rather than the mechanism,
    // and the braces moved: the answer is no longer in the record at all. The
    // shared predicate is "audio present, no terminal state" and takes no clock,
    // because a stamp in the record answered a question about a live process —
    // an app killed one second ago left one that still looked fresh, and the
    // meeting §6's destructive test is about was withheld from this very offer.
    // Main subtracts its own live captures at the channel, from a writer map
    // that dies with the writer. What this window still knows that neither can
    // is the moment BEFORE the session exists (Record has been pressed, `begin`
    // has not returned) — which is what `exclude` and `arming` are left for.
    //
    // Invariant 5 — and it is the whole HAND, not the capture the live rows
    // happen to be bound to. Record → Stop → Record left the first capture out
    // of this list the instant the second one was bound, so the form offered to
    // transcribe half of the meeting it was still recording the other half of,
    // and Create then filed that half and released nothing.
    void capture.resumable(captureScope, hold.inHand.length ? { exclude: hold.inHand } : {})
      .then((rows) => { if (active) { setRecoveries(rows); setRecoveryError(""); } })
      .catch((caught) => { if (active) { setRecoveries([]); setRecoveryError(errorText(caught, "Could not check this device for unfinished recordings.")); } });
    // The complement, and the reason a second window has anything to say at all.
    // A failure here is NOT surfaced: it degrades to "nobody is recording", which
    // is the answer this surface gave before any of this existed, and the offer's
    // own error above already covers "the store could not be read".
    void capture.writing(captureScope)
      .then((rows) => { if (active) setWriters(rows); })
      .catch(() => { if (active) setWriters([]); });
    return () => { active = false; };
  }, [capture, captureScope, hold.inHand, recoveryRevision]);
  /**
   * ADR-028 — and the answer above is corrected the instant it becomes wrong.
   *
   * Both lists are re-queried, because one event changes both: a recording that
   * ends leaves the writers and joins the offer. Without this a second window
   * would sit on the answer it happened to fetch when it mounted — for this page
   * view, for ever — which is the "show nothing and hope the user clicks
   * something" this ADR's companion decision is against. There is no interval
   * and no expiry to wait out: main knows, so main says.
   */
  useEffect(() => capture.onWriters(() => setRecoveryRevision((value) => value + 1)), [capture]);

  /**
   * D6 — the writer that is NOT this window, and what to say about it.
   *
   * Our own capture is dropped on purpose: a panel telling you that you are
   * recording is noise on the surface you are recording from. So this is the
   * first row belonging to somebody else, and the sentence came with it.
   */
  const foreign = useMemo(
    () => writers.find((row) => row.holderId !== capture.holderId),
    [capture, writers],
  );
  /**
   * D6 — every capture this window must not touch: the ones another window is
   * recording.
   *
   * Read twice, by the two things that need it — the offer's rows, and the rule
   * behind Create — so the button and the rule cannot come to different answers
   * about the same set.
   */
  const lockedIds = useMemo(
    () => new Set(writers.filter((row) => row.holderId !== capture.holderId).map((row) => row.sessionId)),
    [capture, writers],
  );

  /**
   * D8 — the IMPORT path, unchanged: one file, one request, and the size limit
   * that goes with actually posting a whole file. Captures no longer come this
   * way (D3), which is the only reason the limit can stay here honestly.
   */
  const transcribeFile = useCallback(async (blob: Blob) => {
    setBusy("transcribe"); setError("");
    try {
      if (!blob.size) throw new Error("The selected audio file is empty.");
      if (blob.size > MAX_AUDIO_BYTES) throw new Error("Imported audio must be 40 MB or smaller.");
      const result = await ops.transcribeAudio({ bytes: new Uint8Array(await blob.arrayBuffer()), contentType: blob.type || "audio/webm", ...(language === "auto" ? {} : { language }) });
      if (!result.text.trim()) throw new Error("No speech was detected in that audio.");
      const text = result.text.trim();
      editTranscript(transcriptRef.current ? `${transcriptRef.current}\n${text}` : text);
    } catch (caught) { setError(errorText(caught, "Could not transcribe that audio.")); }
    finally { setBusy(""); }
  }, [editTranscript, language, ops]);

  /**
   * D3 — "transcribe this recording" is now a request that the HOST start
   * draining its segments, not an upload of the whole capture.
   *
   * Nothing here reads the audio: the bytes never come back to the renderer, so
   * neither a 40 MB body nor an hour-long meeting is a limit any more, and the
   * text arrives segment by segment on the progress channel.
   *
   * G2 — and the two conditions the button is disabled for are ENFORCED here, in
   * the function, from the values that are true at the instant it runs. A
   * `disabled` is a statement about a pixel: React renders it a commit late, and
   * a click that arrives in the same commit as the state that should have
   * stopped it reaches the handler with the attribute still false.
   *
   * `busy` is deliberately NOT among them. It is the only one of the three that
   * is not destructive: an adopt landing mid-create adds a capture the create
   * has already snapshotted past (see `submit`), so the worst it can do is leave
   * that capture unfiled — which is what the offer is for — rather than release
   * audio that is still being written or take a recording away from its own
   * live surface.
   */
  const adoptCapture = useCallback(async (sessionId: string) => {
    // Invariant 5. Rebinding the live surface away from a capture still being
    // written to leaves the recorder feeding a session nothing on screen is
    // watching, and Create would then finalize BOTH — deleting the directory the
    // microphone is still appending to. `captureInHand` rather than
    // `captureInFlight` because the settle ends the flight and NOT the hand: one
    // tick after Stop this was live again, and adopting there merged two meetings
    // into one POST and released the audio of the wrong one.
    if (captureInHand(holdStore.current)) return;
    // D6 — and the same question asked of MAIN, which is the only thing that can
    // see a second window. Main refuses the pick-up itself, so this is what turns
    // a rejected IPC into the sentence the panel above is already showing.
    const held = writers.find((row) => row.sessionId === sessionId && row.holderId !== capture.holderId);
    if (held) { setError(`${held.note} It cannot be transcribed from here while that recording is running.`); return; }
    setError("");
    try {
      // `arming` for a pick-up as well as for a Record: it is what makes this
      // stretch visible to every other control. Without it a Record landing
      // inside the IPC below started a second capture, and Create then finalized
      // — deleted — the recovered meeting without one of its words reaching the
      // box. Lowered in the `finally` below, on both branches.
      holdStore.update({ sessionId, arming: true });
      // The previous capture's phase says nothing about this one, and a stale
      // "the service is not answering" over a queue that has not run yet would
      // be the same lie in the other direction. D10's answer is per capture for
      // the same reason, and a picked-up recording has no live path at all —
      // nobody is producing audio for it, so nothing is being streamed.
      setPhase(null);
      setTranscription(null);
      setLiveSpeech([]);
      const session = await capture.adopt(sessionId);
      /**
       * D4 — what the box ALREADY accounts for, before anything is folded in.
       *
       * `EMPTY_TRANSCRIPT_FOLD` here was the fatal defect: a restored draft (and
       * a box this window had already folded into) holds this capture's settled
       * segments verbatim, so starting the fold at zero appended every one of
       * them a second time — and the doubled text is what was POSTed and
       * summarized. The shared rule decides what is already there, and
       * `beginTranscriptFold` is how that answer becomes a resume point — a
       * host that assembled one itself is a host that can assemble it wrongly.
       *
       * It must run BEFORE `applySession`, which is what folds. The dashboard
       * calls the same rule for the same defect — D1b.
       */
      const reconciled = reconcileCaptureDraft(transcriptRef.current, session);
      foldRef.current = beginTranscriptFold(reconciled);
      if (reconciled.text !== transcriptRef.current) editTranscript(reconciled.text);
      applySession(session);
      // E — the recovered meeting's own name, which the card two lines above is
      // already displaying. Without this, Create stayed disabled after a crash
      // until the user retyped a title the surface could see and they could not.
      // Never over an existing one: a title in the box is something a person put
      // there, and the capture's is at most what they called it when they
      // started it.
      if (session.title) setTitle((current) => current || session.title);
      setRecoveries((rows) => rows.filter((row) => row.sessionId !== sessionId));
    } catch (caught) { setError(errorText(caught, "Could not start transcribing that recording.")); }
    // In a `finally` so a pick-up that THREW cannot wedge Record for the life of
    // the form — the same reason `stopRecording` lowers `closing` in one.
    finally { holdStore.update({ arming: false }); }
  }, [applySession, capture, editTranscript, holdStore, writers]);

  /**
   * §6 — hearing the audio that survived.
   *
   * The destructive test asks for the recording to be on disk and PLAYABLE, and
   * a recovery card that can only offer "transcribe it" cannot answer that: a
   * user whose transcription endpoint is down has no way to confirm the meeting
   * is really there. `read` concatenates saved chunks in durability order, which for
   * a `MediaRecorder` timeslice is the original container stream.
   *
   * A saved chunk the store could not read back does not stop the other fifty-nine
   * minutes from playing — it is COUNTED and said out loud under the player. The
   * alternative was what this used to do: one unreadable file rejected the whole
   * concatenation, and the user was shown an errno for a recording whose byte
   * count the card above was still advertising.
   */
  const playCapture = useCallback(async (sessionId: string) => {
    // Read BEFORE the await, which is what makes this survivable: the answer to
    // "is this still my form?" is a life this attempt belongs to, not a flag a
    // teardown lowered once and nothing raises.
    const life = formLife.begin();
    setError("");
    setBusy(`play:${sessionId}`);
    try {
      const audio = await capture.read(sessionId);
      // Checked AFTER the await and BEFORE the URL exists: an object URL minted
      // for a form that has already closed is one nothing will ever revoke.
      if (formLife.ended(life)) return;
      // Nothing readable at all is not a player with a caption under it: there
      // is nothing to play, and an empty `<audio>` that silently refuses to
      // start is exactly the surface ADR-028 asks us not to build.
      if (!audio.bytes.byteLength) {
        setError(audio.missing.length
          ? "None of this recording could be read back from this device. Its saved audio chunks are missing."
          : "This recording has no audio on this device.");
        return;
      }
      setPreview({ sessionId, url: URL.createObjectURL(new Blob([audio.bytes], { type: audio.contentType })), missing: audio.missing.length });
    } catch (caught) { setError(errorText(caught, "Could not read that recording back from this device.")); }
    finally { setBusy(""); }
  }, [capture, formLife]);

  /** D5 — the retry affordance on a stated gap, from the audio still on disk. */
  const retrySegment = useCallback(async (index: number) => {
    const sessionId = holdStore.current.sessionId;
    if (!sessionId) return;
    setRetrying(index);
    setError("");
    try { applySession(await capture.retrySegment(sessionId, index)); }
    catch (caught) { setError(errorText(caught, "Could not retry that segment.")); }
    finally { setRetrying(null); }
  }, [applySession, capture]);

  /**
   * G2 — Record, and the rule that says there may only be one.
   *
   * The refusal is the FIRST statement and it reads the synchronous hold,
   * because the button's `disabled` cannot cover the commit it is raised in.
   * `arming` goes up before the first await, so React does disable the pixel
   * across the microphone prompt and a human double-click will normally not
   * land in one commit — but "normally" is not the rule, and this repo's own
   * position is that a `disabled` is a statement about a pixel. Two handlers in
   * one commit gave two `captureBegin` calls and two microphone streams; Stop
   * reached only the second, because `recorderRef.current` had been overwritten
   * by it. The first went on recording, went on appending after Stop, kept its
   * stream open — and main subtracts live writers from the offer, so no row
   * existed for it anywhere in the app. Nothing could reach it again short of
   * quitting.
   */
  const startRecording = useCallback(async () => {
    // Deliberately the NARROW rule. Record → Stop → Record is two takes of one
    // meeting — the microphone released for a break and picked up again — and
    // Create files both, so holding a capture is no reason to refuse. What must
    // be refused is a pick-up still in flight, which `arming` covers: the loss
    // was Record landing inside `adoptCapture`'s IPC, after which Create
    // finalized the recovered meeting without one of its words reaching the box.
    if (captureInFlight(holdStore.current)) return;
    setError("");
    // ADR-028 — a build that cannot write the audio down says so, rather than
    // recording into memory and looking exactly like a durable capture.
    if (!capture.available) { setError("This build cannot store meeting audio safely. Restart BrainRouter after updating the desktop app."); return; }
    // A new recording is a fresh question about the disk, so the previous one's
    // durability warnings are cleared here — and nowhere else.
    setCaptureIssue("");
    setRecordIssue("");
    const recorder = new MeetingCaptureRecorder({ capture, onChunkError: setCaptureIssue });
    // F3 — raised BEFORE the first await and lowered only once the recorder is
    // running or has failed to start. `recording` cannot cover this stretch: it
    // is set at the very end, and by then `begin` has already created the
    // session and its directory. A Create landing in that window finalizes and
    // DELETES a capture the recorder is about to start appending to — and
    // `getUserMedia` can sit on a permission prompt for as long as the person
    // takes to answer it.
    holdStore.update({ arming: true });
    // G1 — and parked where the teardown below can REACH it, also before the
    // first await. The unmount effect stops `recorderRef.current`, and this used
    // to be assigned only once `start` had returned: leaving Meetings while the
    // microphone prompt was up therefore stopped nothing, and the recording
    // started on a view that no longer existed. The microphone stayed open, the
    // chunks kept being written, and main went on claiming the capture under a
    // holder id whose window was gone — filtered out of every offer by
    // `isWriting`, dropped from this window's own writers panel as "mine", and
    // refused to every other window. `start` is cancellable across both of its
    // awaits, and this is what does the cancelling.
    recorderRef.current = recorder;
    try {
      const sessionId = await recorder.start({
        scope: captureScope, title, template,
        ...(language === "auto" ? {} : { language }),
      });
      // A genuinely fresh capture: `begin` mints a session with no segments, so
      // there is nothing for the shared reconciliation to find and the fold
      // starts at zero over whatever the box already holds. The RESTORED case —
      // a box that already holds a capture's settled text — is `adoptCapture`'s,
      // and is the one an empty fold gets wrong.
      foldRef.current = EMPTY_TRANSCRIPT_FOLD;
      liveRef.current = null;
      setLive(null);
      setPhase(null);
      // D10 — a fresh recording asks the endpoint again. Carrying the last
      // meeting's answer over would show "Live" for a capture whose capability
      // request has not returned, which is the shape of claim ADR-028 refuses.
      setTranscription(null);
      setLiveSpeech([]);
      holdStore.update({ sessionId, recording: true, arming: false, closing: false });
      setPaused(false);
    } catch (caught) {
      holdStore.update({ arming: false });
      // The slot is deliberately left as it is. A recorder that never started is
      // inert — `stop` on it answers `null`, `togglePause` cannot be reached
      // without `recording`, and the next Record overwrites it — while clearing
      // it would race the other direction: a cancelled attempt rejects long
      // after a second Record has parked ITS recorder here, and blanking that
      // one is how a live recording becomes unreachable from the teardown.
      // `CaptureCancelledError` carries its own sentence for the same reason it
      // has its own type: if this ever does reach a surface it should say what
      // happened, not "Could not start recording." over a stop somebody asked
      // for (ADR-028).
      setError(errorText(caught, "Could not start recording."));
    }
  }, [capture, captureScope, language, template, title, holdStore]);

  /**
   * D3/D7 — Stop ends the RECORDING, not the transcription.
   *
   * There is nothing to upload here: every durability chunk has been going to the host
   * queue as it landed, and the tail keeps draining in main whether or not this
   * window stays open.
   *
   * F3 — but Stop is not instantaneous, and `recording` goes false on its first
   * line. `recorder.stop()` waits for `onstop`, then for the final chunk's
   * `arrayBuffer`, the IPC and the disk write, and only then marks the capture
   * stopped. Across all of that the Create button sits in the same row, and it
   * finalizes the capture — so `closing` goes UP in the same commit `recording`
   * goes down, and comes down in a `finally` so a settle that THREW cannot wedge
   * Create for good.
   */
  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    holdStore.update({ recording: false, closing: Boolean(recorder) });
    setPaused(false);
    if (!recorder) return;
    try {
      const sessionId = await recorder.stop();
      if (!sessionId) return;
      holdStore.update({ sessionId });
      try { applySession(await capture.adopt(sessionId)); }
      catch (caught) { setError(errorText(caught, "Could not read the state of that recording.")); }
    } finally { holdStore.update({ closing: false }); }
  }, [applySession, capture, holdStore]);

  const togglePause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.paused) recorder.resume(); else recorder.pause();
    setPaused(recorder.paused);
  }, []);

  /**
   * D6 — an explicit discard is a real deletion of the audio, not a hidden row.
   *
   * F1 — and it is CONFIRMED, and refused outright for a capture that is still
   * being written to. The store's `discard` has no guard of its own: it deletes
   * the directory whatever the status says, so a discard of the live recording
   * left the microphone open, every later chunk refused with "no longer on this
   * device", and the composer still offering "Stop recording" for a capture that
   * no longer existed. The offer no longer lists that capture at all (see
   * `resumable`'s `exclude`), which is what makes this branch unreachable —
   * which is precisely why it is here: an unreachable delete is one refactor
   * away from being reachable again, and this one is not undoable.
   */
  const discardCapture = useCallback(async (sessionId: string) => {
    const hold = holdStore.current;
    if (hold.sessionId === sessionId && captureInFlight(hold)) return;
    // D6 — and the same question asked of MAIN, which is the only thing that can
    // see a SECOND window. This branch is what the whole registry exists for: the
    // offer stops listing a live capture, so reaching here at all means the row
    // was already stale when it was clicked — and this delete is not undoable.
    // The sentence came from main, so the words here and the words main throws
    // when it refuses the same click are the same words.
    const held = writers.find((row) => row.sessionId === sessionId && row.holderId !== capture.holderId);
    if (held) { setError(`${held.note} Its audio cannot be deleted while it is being recorded.`); return; }
    if (!globalThis.confirm?.("Discard this unfinished recording? Its audio is deleted from this device.")) return;
    try { await capture.discard(sessionId); }
    catch (caught) { setError(errorText(caught, "Could not delete that recording.")); return; }
    // Invariant 5 — a discard is the other way a capture is FILED, so this is
    // where it leaves the hand. `file` also drops the live binding when this was
    // it, and does nothing at all for a recovery row this form never took.
    const wasBound = holdStore.current.sessionId === sessionId;
    holdStore.file(sessionId);
    if (wasBound) {
      // The text it produced stays in the box — the user asked us to delete the
      // AUDIO, not the transcript they may already have edited.
      liveRef.current = null;
      setLive(null);
      setPhase(null);
      setTranscription(null);
      setLiveSpeech([]);
    }
    // A preview of audio that no longer exists is the one copy of it left in the
    // app, which is not what "delete it for good" means.
    setPreview((current) => current?.sessionId === sessionId ? null : current);
    setRecoveries((rows) => rows.filter((row) => row.sessionId !== sessionId));
  }, [capture, holdStore, writers]);

  const importAudio = useCallback((event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) void transcribeFile(file); event.target.value = ""; }, [transcribeFile]);

  const submit = useCallback(async () => {
    /**
     * The whole of what this click may do is decided in `composeSubmit.ts`,
     * from the values that are true RIGHT NOW rather than the ones React last
     * rendered — the guard is the last thing between a running recorder and the
     * delete D6 performs, and a disabled attribute is a statement about a pixel.
     * Nothing here assembles any part of the create input: a settle step whose
     * result the caller could quietly drop is one no assertion can hold, and
     * that is exactly how this step went untested while it lost a gap marker
     * and the segment behind it.
     */
    const prepared = prepareSubmission({
      title, template, transcript: transcriptRef.current, session: liveRef.current,
      fold: foldRef.current, hold: holdStore.current, busy: Boolean(busy),
      // D6 — main's answer about the captures behind this box, and only about
      // captures belonging to somebody else: a window has to be able to finish
      // the meeting it recorded, so a rule that asked "is anybody recording
      // this?" would refuse the one window entitled to press the button. Asked
      // of the whole HAND, because the whole hand is what the create releases.
      heldByAnother: holdStore.current.inHand.some((id) => lockedIds.has(id)),
      ...(orgId ? { activeOrgId: orgId } : {}),
    });
    if (!prepared.ok) return;
    /**
     * Invariant 5 — the captures this submission is filing, read BEFORE the
     * create's await.
     *
     * These are the captures behind the text `prepareSubmission` just settled,
     * so they are the ones the meeting is made of and the ones whose audio has
     * therefore done its job. A capture taken DURING the create — a pick-up on a
     * second click — is not one of them, and finalizing it would delete audio
     * this meeting does not contain.
     */
    const filing = holdStore.current.inHand;
    setBusy("create"); setError("");
    // D5 — the box now says what is being posted, gaps included, rather than
    // the user discovering them in the saved transcript.
    if (prepared.changed) { foldRef.current = prepared.fold; editTranscript(prepared.input.transcript); }
    // D6 — from here the draft is on its way out, so a pending autosave must not
    // put it back. Released again if the create fails: the form still holds the
    // only copy of what the user typed.
    draftRetiredRef.current = true;
    try {
      const result = await ops.createFromTranscript(prepared.input, prepared.orgId);
      // D6 — the meeting exists on the account, so the captured audio has done
      // its job and is released. Deliberately after the create succeeds: audio
      // that is deleted before the transcript is safe somewhere is audio lost.
      //
      // Invariant 5 — EVERY capture in hand, not the one the live rows were last
      // bound to. Record → Stop → Record posts both halves as one meeting, and
      // releasing only the second left the first with a status D6's sentence was
      // never applied to: its audio stayed on the device and the next glance at
      // the library offered to transcribe words this meeting already contains.
      for (const sessionId of filing) {
        try {
          await capture.finalize(sessionId);
          setRecoveries((rows) => rows.filter((row) => row.sessionId !== sessionId));
        } catch (caught) {
          // ADR-028 — swallowing this left the session non-terminal, so the next
          // launch advertised a meeting that SUCCEEDED as an interrupted
          // recording: a state the surface never established. The row stays in
          // the offer because the audio really is still here, and the library
          // owns the message because this form is about to close.
          onAudioRetained({ sessionId, message: `"${prepared.input.title}" was created, but its recording is still on this device — ${errorText(caught, "the capture store refused the delete.")}` });
        }
        // Filed either way. A release that FAILED is still a capture this form
        // has finished with — the library owns it from here, as a notice with a
        // retry — and leaving it in the hand would keep excluding it from the
        // offer that is now the only way back to it.
        holdStore.file(sessionId);
      }
      // D6 — the meeting holds these words now, so the draft's copy of them
      // stops existing. Not fatal if it fails: the meeting was created, and the
      // form is about to close, so this is reported nowhere rather than as a
      // failure of the thing the user just did successfully.
      await capture.clearDraft().catch(() => undefined);
      await onCreated(result.id);
    } catch (caught) {
      draftRetiredRef.current = false;
      setError(errorText(caught, "Could not create this meeting."));
    }
    finally { setBusy(""); }
  }, [busy, capture, editTranscript, lockedIds, onAudioRetained, onCreated, ops, orgId, template, title, holdStore]);

  // ADR-028 — how many segments would become gaps if the meeting were created
  // right now. Said before the click, not discovered in the saved transcript.
  const unresolved = live ? unsettledSegments(live).length : 0;
  // F3 — the same rule `submit` refuses on, projected onto the pixels. Not the
  // rule itself: this is React's last render, and Stop lowers `recording` before
  // the final chunk has landed.
  const capturing = captureInFlight(hold);
  // Invariant 5, projected onto the two controls that can TAKE ON another
  // capture. Wider than `capturing`, and deliberately not used for Create or
  // Delete: filing is how a capture leaves the hand, so gating those on it would
  // build a state with no way out.
  const holding = captureInHand(hold);
  /**
   * D6 — `prepareSubmission`'s fourth invariant, projected onto the pixels:
   * another window is recording one of the captures behind this box.
   *
   * The rule reads the same `lockedIds` over the synchronous hand, because a
   * disabled attribute is a statement about a pixel and the rule has to be about
   * the value that is true now. `lockedIds` also locks the offer's rows — a row
   * a live writer owns cannot be transcribed away or deleted from here, however
   * stale the list has become.
   */
  const heldByAnother = hold.inHand.some((id) => lockedIds.has(id));

  return <main className="mv-detail"><button type="button" className="mv-mobile-back" onClick={onCancel}>← Meetings</button><div className="mv-compose"><div className="mv-compose-head"><div><span className="mv-eyebrow">Capture</span><h3>New meeting</h3><p>Record, import audio, or paste a transcript. Your draft stays on this device until it is summarized.</p></div>{recovered ? <span className="mv-recovered">Draft recovered</span> : null}</div>{error ? <div className="mv-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}{captureIssue ? <div className="mv-error" role="alert"><span>{captureIssue} This recording may be incomplete.</span><button type="button" onClick={() => setCaptureIssue("")} aria-label="Dismiss recording warning">×</button></div> : null}{recordIssue ? <div className="mv-error" role="alert"><span>{recordIssue}</span><button type="button" onClick={() => setRecordIssue("")} aria-label="Dismiss transcription warning">×</button></div> : null}{foreign ? <div className="mv-recovery" role="status"><strong>{foreign.note}</strong><p>Its audio stays on this device and cannot be transcribed or deleted from here while that recording is running. This page checks again on its own when the recording stops.</p></div> : null}{recoveryError ? <div className="mv-recovery" role="alert"><strong>Could not check for unfinished recordings</strong><p>{recoveryError} Audio already written to this device is still there.</p><button type="button" className="mv-secondary" onClick={() => setRecoveryRevision((value) => value + 1)}>Check again</button></div> : null}{recoveries.length ? <div className="mv-recovery" role="status"><strong>{recoveries.length === 1 ? "An unfinished recording is still on this device" : `${recoveries.length} unfinished recordings are still on this device`}</strong><p>The audio is here whether the app was killed or the recording was simply never turned into a meeting. Transcribe it, or delete it for good.</p>{recoveries.map((row) => <div className="mv-recovery-item" key={row.sessionId}><div className="mv-recovery-row"><span>{row.title}<small>{new Date(row.startedAt).toLocaleString()} · {minutes(row.durationMs)} · {megabytes(row.byteLength)} · {row.segments} segment{row.segments === 1 ? "" : "s"}</small></span><button type="button" className="mv-secondary" disabled={Boolean(busy) || holding || lockedIds.has(row.sessionId)} onClick={() => void adoptCapture(row.sessionId)}>Transcribe it</button><button type="button" className="mv-ghost" disabled={Boolean(busy)} onClick={() => void playCapture(row.sessionId)}>{busy === `play:${row.sessionId}` ? "Loading…" : "▶ Play"}</button><button type="button" className="mv-ghost" disabled={Boolean(busy) || capturing || lockedIds.has(row.sessionId)} onClick={() => void discardCapture(row.sessionId)}>Delete audio</button></div>{preview?.sessionId === row.sessionId ? <><audio className="mv-recovery-audio" controls autoPlay src={preview.url} />{preview.missing ? <small className="mv-recovery-missing">{preview.missing === 1 ? "1 saved audio chunk could not be read back and is" : `${preview.missing} saved audio chunks could not be read back and are`} missing from what plays here. The rest of the audio is intact.</small> : null}</> : null}</div>)}</div> : null}<div className="mv-capture-bar">{recording ? <><button type="button" className="mv-recording" onClick={() => void stopRecording()}><span /> Stop recording</button><button type="button" className="mv-secondary" onClick={togglePause}>{paused ? "Resume" : "Pause"}</button></> : <button type="button" className="mv-secondary" onClick={() => void startRecording()} disabled={Boolean(busy) || capturing}>● Record audio</button>}<label className={`mv-secondary mv-file-btn${busy ? " mv-disabled" : ""}`}>↑ Import audio<input type="file" accept="audio/*" onChange={importAudio} disabled={Boolean(busy)} /></label><span>{busy === "transcribe" ? "Transcribing the imported file…" : `Audio is saved every ${Math.round(DEFAULT_MEETING_CHUNK_MS / 1000)}s · transcription units are about ${Math.round(DEFAULT_MEETING_UNIT_MS / 1000)}s · imports up to 40 MB`}</span></div>{live ? <LiveTranscript session={live} phase={phase} transcription={transcription} utterances={liveSpeech} retrying={retrying} onRetry={(index) => void retrySegment(index)} /> : null}<div className="mv-compose-grid"><label className="mv-field mv-field-wide"><span>Meeting title</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Weekly product sync" maxLength={180} /></label><label className="mv-field"><span>Summary template</span><select value={template} onChange={(event) => setTemplate(event.target.value as CreateMeetingInput["template"])}><option value="general">General</option><option value="standup">Stand-up</option><option value="one-on-one">1:1</option><option value="retrospective">Retrospective</option></select></label><label className="mv-field"><span>Audio language</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="auto">Auto-detect</option><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="ja">Japanese</option></select></label><label className="mv-field mv-field-wide"><span>Transcript</span><textarea value={transcript} onChange={(event) => editTranscript(event.target.value)} placeholder="Paste a transcript here, or record/import audio above…" /></label></div><div className="mv-compose-actions"><button type="button" className="mv-primary" disabled={!title.trim() || !transcript.trim() || Boolean(busy) || capturing || heldByAnother} onClick={() => void submit()}>{busy === "create" ? "Creating & summarizing…" : hold.closing ? "Saving the recording…" : "Create meeting"}</button><button type="button" className="mv-secondary" onClick={onCancel}>Cancel</button>{capturing ? <span className="mv-unresolved">Stop the recording before creating the meeting — creating it releases the captured audio, and the chunk being written right now would have nowhere to land.</span> : unresolved > 0 ? <span className="mv-unresolved">{unresolved === 1 ? "1 segment is still being transcribed" : `${unresolved} segments are still being transcribed`} — creating the meeting now states them as gaps.</span> : null}</div></div></main>;
}
