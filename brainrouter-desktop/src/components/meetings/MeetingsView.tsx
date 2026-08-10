import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import {
  DEFAULT_MEETING_SEGMENT_MS,
  formatCaptureTimestamp,
  transcriptSoFar,
  unsettledSegments,
  MEETING_ENDPOINT_UNRESPONSIVE_REASON,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
  type MeetingDrainPhase,
  type MeetingRecoverySummary,
} from "@kinqs/brainrouter-core/meetings";
import "./meetings.css";
import { MeetingTracksView } from "./MeetingTracksView.js";
import { SharePopover } from "./SharePopover.js";
import { TeamsView } from "./TeamsView.js";
import { createMeetingCaptureOps, type MeetingCaptureProgress } from "./captureOps.js";
import { MeetingCaptureRecorder } from "./captureRecorder.js";
import { EMPTY_TRANSCRIPT_FOLD, foldTranscript, type TranscriptFold } from "./liveTranscript.js";
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
const DRAFT_KEY = "brainrouter:desktop-meeting-draft";
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

export function MeetingsView({ ops }: { ops: MeetingsOps }): ReactElement {
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
  useEffect(() => {
    let active = true;
    const released = new Set(retainedKey ? retainedKey.split(" ") : []);
    void capture.resumable({ orgId: scopedOrgId ?? null })
      .then((rows) => { if (active) { setInterrupted(rows.filter((row) => !released.has(row.sessionId)).length); setRecoveryError(""); } })
      .catch((caught) => { if (active) { setInterrupted(0); setRecoveryError(errorText(caught, "Could not check this device for interrupted recordings.")); } });
    // Re-read when compose closes: a capture recovered or discarded in there is
    // one this banner must stop advertising.
    return () => { active = false; };
  }, [capture, composing, recoveryRevision, retainedKey, scopedOrgId]);

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

  return (
    <div className="mv-shell">
      <div className="mv-tabs" role="tablist" aria-label="Meetings sections">
        {(["meetings", "tracked", "teams"] as const).map((tab) => <button type="button" key={tab} role="tab" aria-selected={mode === tab} className={`mv-tab${mode === tab ? " mv-on" : ""}`} onClick={() => setMode(tab)}>{tab === "tracked" ? "Track" : tab[0].toUpperCase() + tab.slice(1)}</button>)}
        {mode !== "teams" && activeContext ? <span className="mv-orgctx-label" title="Workspace — switch from the activity bar">{activeContext.isPersonal ? `${activeContext.name} · Personal workspace` : activeContext.name}</span> : null}
      </div>
      {mode === "tracked" ? <MeetingTracksView ops={ops} orgId={scopedOrgId} /> : mode === "teams" ? <TeamsView ops={teamsOps} onChanged={() => setTeamRevision((value) => value + 1)} /> : (
        <div className="mv-root">
          <aside className={`mv-col${selectedId || composing ? " mv-col-has-selection" : ""}`}>
            <div className="mv-col-head"><div><span className="mv-eyebrow">Library</span><h2>Meetings <span>{items.length}</span></h2></div><button type="button" className="mv-newbtn" onClick={() => { setComposing(true); setSelectedId(null); }}>+ New</button></div>
            <label className="mv-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search meetings" aria-label="Search meetings" />{query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search">×</button> : null}</label>
            <div className="mv-scope-filters" role="group" aria-label="Filter meeting visibility">{(["all", ...MEETING_SCOPES] as const).map((scope) => <button type="button" key={scope} className={scopeFilter === scope ? "mv-on" : ""} aria-pressed={scopeFilter === scope} onClick={() => setScopeFilter(scope)}>{scope === "org" ? "Org" : scope[0].toUpperCase() + scope.slice(1)}</button>)}</div>
            {error ? <div className="mv-list-error" role="alert">{error}<button type="button" onClick={() => void refreshList()}>Retry</button></div> : null}
            {retained.map((row) => <div className="mv-list-error" role="alert" key={row.sessionId}>{row.message}<button type="button" onClick={() => void releaseRetained(row.sessionId)}>Delete the audio</button></div>)}
            {recoveryError ? <div className="mv-list-error" role="alert">{recoveryError}<button type="button" onClick={() => setRecoveryRevision((value) => value + 1)}>Check again</button></div> : null}
            {interrupted > 0 && !composing ? <button type="button" className="mv-recovery-cta" onClick={() => { setComposing(true); setSelectedId(null); }}><strong>{interrupted === 1 ? "1 interrupted recording" : `${interrupted} interrupted recordings`}</strong><small>The audio is still on this device — recover it</small></button> : null}
            <div className="mv-items">
              {filtered.map((item) => <button type="button" key={item.id} className={`mv-item${!composing && item.id === selectedId ? " mv-on" : ""}`} onClick={() => { setComposing(false); setSelectedId(item.id); }} aria-pressed={!composing && item.id === selectedId}><span className="mv-item-t">{item.title}</span><span className="mv-item-m"><span className="mv-item-d">{item.date}</span><span className={`mv-summary-dot mv-summary-${item.summaryStatus}`} title={`Summary ${item.summaryStatus}`} /><ScopeBadge scope={item.scope} />{!item.canEdit ? <span className="mv-shared-readonly">Shared</span> : null}</span></button>)}
              {!filtered.length ? <div className="mv-state">{loading ? "Loading meetings…" : items.length ? "No meetings match these filters." : "No meetings yet. Record, import audio, or paste a transcript to begin."}</div> : null}
            </div>
            {nextCursor ? <button type="button" className="mv-load-more" disabled={busy === "more-meetings"} onClick={() => void loadMoreMeetings()}>{busy === "more-meetings" ? "Loading…" : "Load more meetings"}</button> : null}
          </aside>

          {composing ? <NewMeeting ops={ops} orgId={scopedOrgId} onAudioRetained={retainAudio} onCancel={() => { setComposing(false); void refreshList(); }} onCreated={async (id) => { await refreshList(); setComposing(false); setSelectedId(id); }} /> : detail ? (
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
      )}
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
 */
function phaseNote(session: MeetingCaptureSession, phase: MeetingDrainPhase | null, gaps: number, provisional: number): string {
  // The longest sentence, on purpose: this is the state a user is most likely to
  // read as "my meeting is being lost", and D7's whole point is that it is not.
  if (phase === "unavailable") return "The transcription service is not answering. The audio is saved on this device, and these segments transcribe when it comes back.";
  if (phase === "closed") return "This meeting is closed; its audio has been released.";
  // D5/D7 — the refunds are spent, so the queue has stopped waiting for the
  // endpoint on these segments' behalf. That is precisely the moment to stop
  // showing a spinner and show the gap, so it outranks "something is in flight".
  if (session.segments.some((segment) => segment.failureReason === MEETING_ENDPOINT_UNRESPONSIVE_REASON)) {
    return "We have stopped waiting for the transcription service on some segments. The audio is still on this device — retry a gap once the service is back.";
  }
  if (provisional > 0) return "";
  if (phase === "waiting") return "Waiting to retry.";
  if (gaps > 0) return "Nothing left to try automatically — retry a gap to fill it in from the audio still on this device.";
  return "";
}

function LiveTranscript({ session, phase, retrying, onRetry }: { session: MeetingCaptureSession; phase: MeetingDrainPhase | null; retrying: number | null; onRetry(index: number): void }): ReactElement {
  const entries = transcriptSoFar(session);
  const settled = entries.filter((entry) => entry.kind === "settled").length;
  const provisional = entries.filter((entry) => entry.kind === "provisional").length;
  const gaps = entries.filter((entry) => entry.kind === "gap").length;
  const note = phaseNote(session, phase, gaps, provisional);
  return (
    <section className="mv-live">
      <div className="mv-card-lab"><span>Live transcript</span><span>{settled} of {entries.length} transcribed{gaps ? ` · ${gaps} gap${gaps === 1 ? "" : "s"}` : ""}</span></div>
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
      ) : <p className="mv-live-empty">The recording is on this device. The first segment is written and transcribed after about {Math.round(DEFAULT_MEETING_SEGMENT_MS / 1000)} seconds.</p>}
      {note ? <p className="mv-live-note">{note}</p> : null}
    </section>
  );
}

function NewMeeting({ ops, orgId, onAudioRetained, onCreated, onCancel }: { ops: MeetingsOps; orgId?: string; onAudioRetained(notice: { sessionId: string; message: string }): void; onCreated(id: string): Promise<void>; onCancel(): void }): ReactElement {
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [template, setTemplate] = useState<CreateMeetingInput["template"]>("general");
  const [language, setLanguage] = useState("auto");
  const [recording, setRecording] = useState(false);
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
  // ADR-035 D4 — the capture this form is watching, as the HOST last persisted
  // it. Never a local guess: everything rendered from it is already on disk.
  const [live, setLive] = useState<MeetingCaptureSession | null>(null);
  // D7 — where the host's queue stopped. Nothing in the session says whether the
  // endpoint is answering, so without this a stalled queue and a working one
  // render the same. Null until the host has drained at least once.
  const [phase, setPhase] = useState<MeetingDrainPhase | null>(null);
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
  const [preview, setPreview] = useState<{ sessionId: string; url: string } | null>(null);
  // ADR-035 D2 — captures from a previous run that hold audio and never reached
  // a terminal state. The list is the recovery offer; the shared model decides
  // which sessions qualify and scopes them to the org now in context.
  const [recoveries, setRecoveries] = useState<MeetingRecoverySummary[]>([]);
  // ADR-028 — the offer to resume is this ADR's deliverable, so a query that
  // could not run says so rather than looking like a device with no audio on it.
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const capture = useMemo(() => createMeetingCaptureOps(), []);
  const captureScope = useMemo<MeetingCaptureScope>(() => ({ orgId: orgId ?? null }), [orgId]);
  const recorderRef = useRef<MeetingCaptureRecorder | null>(null);
  // The capture whose audio produced the transcript in the box. Held so the
  // audio can be released once the meeting is created (D6) — never to hold audio.
  const captureIdRef = useRef<string | null>(null);
  // D4 — the box's current value, mirrored so a segment arriving between renders
  // folds into what the user has typed rather than into a stale snapshot. It is
  // written by every path that changes the box, including the user's keystrokes.
  const transcriptRef = useRef("");
  const foldRef = useRef<TranscriptFold>(EMPTY_TRANSCRIPT_FOLD);
  const liveRef = useRef<MeetingCaptureSession | null>(null);
  // False once this form is gone. Reading a recording back is a real allocation
  // that takes a moment, and a `setPreview` after unmount is dropped by React —
  // leaving an object URL nothing will ever revoke, pinning a whole meeting in
  // this window's heap. That is §1's defect in miniature, so the URL is only
  // minted while there is still something to revoke it.
  const mountedRef = useRef(true);

  /** The one place the box is written to from a segment — see `liveTranscript.ts`. */
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
    if (progress.errors?.length) {
      setRecordIssue(`This meeting's record could not be written to this device: ${progress.errors[0]} The audio already captured is still here, but the transcript may stop filling in until that write succeeds.`);
    }
    applySession(progress.session);
  }, [applySession]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as { title?: string; transcript?: string; template?: CreateMeetingInput["template"]; language?: string } | null;
      if (saved?.title) setTitle(saved.title); if (saved?.transcript) editTranscript(saved.transcript); if (saved?.template) setTemplate(saved.template); if (saved?.language) setLanguage(saved.language);
      setRecovered(Boolean(saved?.title || saved?.transcript));
    } catch { /* ignore invalid local drafts */ }
  }, [editTranscript]);
  // D4 — the host pushes every persisted change. Subscribing here (rather than
  // polling) is what lets a segment appear the moment it is durable, and the
  // filter is by capture id because main broadcasts to every window.
  useEffect(() => capture.onProgress((progress) => {
    if (progress.sessionId !== captureIdRef.current) return;
    applyProgress(progress);
  }), [applyProgress, capture]);
  // The object URL is a handle on a whole recording held in this window's heap,
  // so it is released the moment another one replaces it or the form closes.
  useEffect(() => {
    if (!preview) return undefined;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      if (title || transcript) localStorage.setItem(DRAFT_KEY, JSON.stringify({ title, transcript, template, language })); else localStorage.removeItem(DRAFT_KEY);
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [language, template, title, transcript]);
  // Unmounting releases the microphone but does NOT discard the capture: the
  // chunks already written stay on disk and are offered back next launch (D2).
  useEffect(() => () => { mountedRef.current = false; void recorderRef.current?.dispose(); }, []);
  useEffect(() => {
    let active = true;
    void capture.resumable(captureScope)
      .then((rows) => { if (active) { setRecoveries(rows); setRecoveryError(""); } })
      .catch((caught) => { if (active) { setRecoveries([]); setRecoveryError(errorText(caught, "Could not check this device for interrupted recordings.")); } });
    return () => { active = false; };
  }, [capture, captureScope, recoveryRevision]);

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
   */
  const adoptCapture = useCallback(async (sessionId: string) => {
    setError("");
    try {
      captureIdRef.current = sessionId;
      // A different capture than the one already folded in: start the fold over
      // so its settled segments are appended rather than assumed present.
      foldRef.current = EMPTY_TRANSCRIPT_FOLD;
      // The previous capture's phase says nothing about this one, and a stale
      // "the service is not answering" over a queue that has not run yet would
      // be the same lie in the other direction.
      setPhase(null);
      applySession(await capture.adopt(sessionId));
      setRecoveries((rows) => rows.filter((row) => row.sessionId !== sessionId));
    } catch (caught) { setError(errorText(caught, "Could not start transcribing that recording.")); }
  }, [applySession, capture]);

  /**
   * §6 — hearing the audio that survived.
   *
   * The destructive test asks for the recording to be on disk and PLAYABLE, and
   * a recovery card that can only offer "transcribe it" cannot answer that: a
   * user whose transcription endpoint is down has no way to confirm the meeting
   * is really there. `read` concatenates the segments in index order, which for
   * a `MediaRecorder` timeslice is the original container stream.
   */
  const playCapture = useCallback(async (sessionId: string) => {
    setError("");
    setBusy(`play:${sessionId}`);
    try {
      const audio = await capture.read(sessionId);
      // Checked AFTER the await and BEFORE the URL exists: an object URL minted
      // for a form that has already closed is one nothing will ever revoke.
      if (!mountedRef.current) return;
      setPreview({ sessionId, url: URL.createObjectURL(new Blob([audio.bytes], { type: audio.contentType })) });
    } catch (caught) { setError(errorText(caught, "Could not read that recording back from this device.")); }
    finally { setBusy(""); }
  }, [capture]);

  /** D5 — the retry affordance on a stated gap, from the audio still on disk. */
  const retrySegment = useCallback(async (index: number) => {
    const sessionId = captureIdRef.current;
    if (!sessionId) return;
    setRetrying(index);
    setError("");
    try { applySession(await capture.retrySegment(sessionId, index)); }
    catch (caught) { setError(errorText(caught, "Could not retry that segment.")); }
    finally { setRetrying(null); }
  }, [applySession, capture]);

  const startRecording = useCallback(async () => {
    setError("");
    // ADR-028 — a build that cannot write the audio down says so, rather than
    // recording into memory and looking exactly like a durable capture.
    if (!capture.available) { setError("This build cannot store meeting audio safely. Restart BrainRouter after updating the desktop app."); return; }
    // A new recording is a fresh question about the disk, so the previous one's
    // durability warnings are cleared here — and nowhere else.
    setCaptureIssue("");
    setRecordIssue("");
    const recorder = new MeetingCaptureRecorder({ capture, onChunkError: setCaptureIssue });
    try {
      captureIdRef.current = await recorder.start({
        scope: captureScope, title, template,
        ...(language === "auto" ? {} : { language }),
      });
      // A new capture folds into whatever is already in the box, from segment
      // zero — the previous capture's fold says nothing about this one.
      foldRef.current = EMPTY_TRANSCRIPT_FOLD;
      liveRef.current = null;
      setLive(null);
      setPhase(null);
      recorderRef.current = recorder;
      setRecording(true); setPaused(false);
    } catch (caught) { setError(errorText(caught, "Could not start recording.")); }
  }, [capture, captureScope, language, template, title]);

  /**
   * D3/D7 — Stop ends the RECORDING, not the transcription.
   *
   * There is nothing to upload here: every segment has been going to the host
   * queue as it landed, and the tail keeps draining in main whether or not this
   * window stays open.
   */
  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecording(false); setPaused(false);
    const sessionId = await recorder?.stop();
    if (!sessionId) return;
    captureIdRef.current = sessionId;
    try { applySession(await capture.adopt(sessionId)); }
    catch (caught) { setError(errorText(caught, "Could not read the state of that recording.")); }
  }, [applySession, capture]);

  const togglePause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.paused) recorder.resume(); else recorder.pause();
    setPaused(recorder.paused);
  }, []);

  /** D6 — an explicit discard is a real deletion of the audio, not a hidden row. */
  const discardCapture = useCallback(async (sessionId: string) => {
    try { await capture.discard(sessionId); }
    catch (caught) { setError(errorText(caught, "Could not delete that recording.")); return; }
    if (captureIdRef.current === sessionId) {
      captureIdRef.current = null;
      // The text it produced stays in the box — the user asked us to delete the
      // AUDIO, not the transcript they may already have edited.
      liveRef.current = null;
      setLive(null);
      setPhase(null);
    }
    // A preview of audio that no longer exists is the one copy of it left in the
    // app, which is not what "delete it for good" means.
    setPreview((current) => current?.sessionId === sessionId ? null : current);
    setRecoveries((rows) => rows.filter((row) => row.sessionId !== sessionId));
  }, [capture]);

  const importAudio = useCallback((event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) void transcribeFile(file); event.target.value = ""; }, [transcribeFile]);

  const submit = useCallback(async () => {
    // The `recording` guard is not defensive tidiness. D4 fills the transcript
    // box live, so a running meeting satisfies every other condition here within
    // twenty seconds — and this function finalizes the capture, which under D6
    // deletes the directory the recorder is still appending to. The next chunk
    // then fails with "no longer on this device", the microphone stays open, and
    // the surface still offers "Stop recording" for a capture that is gone.
    // Guarded here as well as on the button because this is the destructive
    // path; a disabled attribute is a statement about a pixel, not a rule.
    if (!title.trim() || !transcript.trim() || busy || recording) return;
    setBusy("create"); setError("");
    try {
      // D5 — the meeting is about to be created from this text, so anything the
      // queue has not resolved will never reach it. It goes in as a stated gap
      // with its time range rather than as an omission nobody can see, which is
      // the same thing `finalizeCapture` does to the record a moment later.
      let body = transcriptRef.current;
      const session = liveRef.current;
      if (session) {
        const settled = foldTranscript(body, session, foldRef.current, { settleAll: true });
        if (settled.changed) { foldRef.current = settled.fold; body = settled.text; editTranscript(body); }
      }
      const result = await ops.createFromTranscript({ title: title.trim(), transcript: body, template }, orgId);
      // D6 — the meeting exists on the account, so the captured audio has done
      // its job and is released. Deliberately after the create succeeds: audio
      // that is deleted before the transcript is safe somewhere is audio lost.
      const captured = captureIdRef.current;
      captureIdRef.current = null;
      if (captured) {
        try {
          await capture.finalize(captured);
          setRecoveries((rows) => rows.filter((row) => row.sessionId !== captured));
        } catch (caught) {
          // ADR-028 — swallowing this left the session non-terminal, so the next
          // launch advertised a meeting that SUCCEEDED as an interrupted
          // recording: a state the surface never established. The row stays in
          // the offer because the audio really is still here, and the library
          // owns the message because this form is about to close.
          onAudioRetained({ sessionId: captured, message: `"${title.trim()}" was created, but its recording is still on this device — ${errorText(caught, "the capture store refused the delete.")}` });
        }
      }
      localStorage.removeItem(DRAFT_KEY); await onCreated(result.id);
    } catch (caught) { setError(errorText(caught, "Could not create this meeting.")); }
    finally { setBusy(""); }
  }, [busy, capture, editTranscript, onAudioRetained, onCreated, ops, orgId, recording, template, title, transcript]);

  // ADR-028 — how many segments would become gaps if the meeting were created
  // right now. Said before the click, not discovered in the saved transcript.
  const unresolved = live ? unsettledSegments(live).length : 0;

  return <main className="mv-detail"><button type="button" className="mv-mobile-back" onClick={onCancel}>← Meetings</button><div className="mv-compose"><div className="mv-compose-head"><div><span className="mv-eyebrow">Capture</span><h3>New meeting</h3><p>Record, import audio, or paste a transcript. Your draft stays on this device until it is summarized.</p></div>{recovered ? <span className="mv-recovered">Draft recovered</span> : null}</div>{error ? <div className="mv-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}{captureIssue ? <div className="mv-error" role="alert"><span>{captureIssue} This recording may be incomplete.</span><button type="button" onClick={() => setCaptureIssue("")} aria-label="Dismiss recording warning">×</button></div> : null}{recordIssue ? <div className="mv-error" role="alert"><span>{recordIssue}</span><button type="button" onClick={() => setRecordIssue("")} aria-label="Dismiss transcription warning">×</button></div> : null}{recoveryError ? <div className="mv-recovery" role="alert"><strong>Could not check for interrupted recordings</strong><p>{recoveryError} Audio already written to this device is still there.</p><button type="button" className="mv-secondary" onClick={() => setRecoveryRevision((value) => value + 1)}>Check again</button></div> : null}{recoveries.length ? <div className="mv-recovery" role="status"><strong>{recoveries.length === 1 ? "A recording was interrupted" : `${recoveries.length} recordings were interrupted`}</strong><p>The audio is still on this device. Transcribe it, or delete it for good.</p>{recoveries.map((row) => <div className="mv-recovery-item" key={row.sessionId}><div className="mv-recovery-row"><span>{row.title}<small>{new Date(row.startedAt).toLocaleString()} · {minutes(row.durationMs)} · {megabytes(row.byteLength)} · {row.segments} segment{row.segments === 1 ? "" : "s"}</small></span><button type="button" className="mv-secondary" disabled={Boolean(busy) || recording} onClick={() => void adoptCapture(row.sessionId)}>Transcribe it</button><button type="button" className="mv-ghost" disabled={Boolean(busy)} onClick={() => void playCapture(row.sessionId)}>{busy === `play:${row.sessionId}` ? "Loading…" : "▶ Play"}</button><button type="button" className="mv-ghost" onClick={() => void discardCapture(row.sessionId)}>Delete audio</button></div>{preview?.sessionId === row.sessionId ? <audio className="mv-recovery-audio" controls autoPlay src={preview.url} /> : null}</div>)}</div> : null}<div className="mv-capture-bar">{recording ? <><button type="button" className="mv-recording" onClick={() => void stopRecording()}><span /> Stop recording</button><button type="button" className="mv-secondary" onClick={togglePause}>{paused ? "Resume" : "Pause"}</button></> : <button type="button" className="mv-secondary" onClick={() => void startRecording()} disabled={Boolean(busy)}>● Record audio</button>}<label className={`mv-secondary mv-file-btn${busy ? " mv-disabled" : ""}`}>↑ Import audio<input type="file" accept="audio/*" onChange={importAudio} disabled={Boolean(busy)} /></label><span>{busy === "transcribe" ? "Transcribing the imported file…" : `Recording is transcribed every ${Math.round(DEFAULT_MEETING_SEGMENT_MS / 1000)}s · imports up to 40 MB`}</span></div>{live ? <LiveTranscript session={live} phase={phase} retrying={retrying} onRetry={(index) => void retrySegment(index)} /> : null}<div className="mv-compose-grid"><label className="mv-field mv-field-wide"><span>Meeting title</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Weekly product sync" maxLength={180} /></label><label className="mv-field"><span>Summary template</span><select value={template} onChange={(event) => setTemplate(event.target.value as CreateMeetingInput["template"])}><option value="general">General</option><option value="standup">Stand-up</option><option value="one-on-one">1:1</option><option value="retrospective">Retrospective</option></select></label><label className="mv-field"><span>Audio language</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="auto">Auto-detect</option><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="ja">Japanese</option></select></label><label className="mv-field mv-field-wide"><span>Transcript</span><textarea value={transcript} onChange={(event) => editTranscript(event.target.value)} placeholder="Paste a transcript here, or record/import audio above…" /></label></div><div className="mv-compose-actions"><button type="button" className="mv-primary" disabled={!title.trim() || !transcript.trim() || Boolean(busy) || recording} onClick={() => void submit()}>{busy === "create" ? "Creating & summarizing…" : "Create meeting"}</button><button type="button" className="mv-secondary" onClick={onCancel}>Cancel</button>{recording ? <span className="mv-unresolved">Stop the recording before creating the meeting — creating it releases the captured audio, and the chunk being written right now would have nowhere to land.</span> : unresolved > 0 ? <span className="mv-unresolved">{unresolved === 1 ? "1 segment is still being transcribed" : `${unresolved} segments are still being transcribed`} — creating the meeting now states them as gaps.</span> : null}</div></div></main>;
}
