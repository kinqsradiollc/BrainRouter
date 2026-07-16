import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import "./meetings.css";
import { MeetingTracksView } from "./MeetingTracksView.js";
import { SharePopover } from "./SharePopover.js";
import { TeamsView } from "./TeamsView.js";
import { createTeamsOps } from "./teamsOps.js";
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
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
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

  const refreshList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await ops.listPage({ limit: 50 });
      setItems(page.meetings);
      setNextCursor(page.nextCursor);
      setSelectedId((current) => current && page.meetings.some((item) => item.id === current) ? current : page.meetings[0]?.id ?? null);
    } catch (caught) {
      setItems([]);
      setNextCursor(null);
      setSelectedId(null);
      setError(errorText(caught, "Could not load meetings."));
    } finally { setLoading(false); }
  }, [ops]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  const loadMoreMeetings = useCallback(async () => {
    if (!nextCursor || busy) return;
    setBusy("more-meetings");
    try {
      const page = await ops.listPage({ cursor: nextCursor, limit: 50 });
      setItems((current) => [...current, ...page.meetings.filter((row) => !current.some((existing) => existing.id === row.id))]);
      setNextCursor(page.nextCursor);
    } catch (caught) { setError(errorText(caught, "Could not load more meetings.")); }
    finally { setBusy(""); }
  }, [busy, nextCursor, ops]);

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
    void ops.overview(id).then((overview) => {
      if (active) { setDetail({ ...overview, transcript: [] }); setDraftSummary(overview.summaryMarkdown); }
    }).catch((caught) => { if (active) setDetailError(errorText(caught, "Could not load this meeting.")); })
      .finally(() => { if (active) setDetailLoading(false); });
    void ops.transcriptPage(id, { limit: 100 }).then((page) => {
      if (active) { setTranscript(page.segments); setTranscriptNext(page.nextCursor); setTranscriptTotal(page.total); }
    }).catch((caught) => { if (active) setDetailError(errorText(caught, "Could not load the transcript.")); })
      .finally(() => { if (active) setTranscriptLoading(false); });
    return () => { active = false; };
  }, [composing, ops, selectedId]);

  useEffect(() => {
    if (!detail || !["queued", "processing"].includes(detail.summaryStatus)) return;
    let active = true;
    const id = detail.id;
    const timer = globalThis.setInterval(() => {
      void ops.overview(id).then((overview) => {
        if (!active) return;
        setDetail((current) => current?.id === id ? { ...current, ...overview } : current);
        setItems((list) => list.map((item) => item.id === id ? { ...item, summaryStatus: overview.summaryStatus } : item));
      }).catch(() => undefined);
    }, 3000);
    return () => { active = false; globalThis.clearInterval(timer); };
  }, [detail?.id, detail?.summaryStatus, ops]);

  const loadMoreTranscript = useCallback(async () => {
    if (!detail || !transcriptNext || transcriptLoading) return;
    const id = detail.id;
    setTranscriptLoading(true);
    try {
      const page = await ops.transcriptPage(id, { cursor: transcriptNext, limit: 100 });
      if (detail.id === id) setTranscript((current) => [...current, ...page.segments]);
      setTranscriptNext(page.nextCursor);
      setTranscriptTotal(page.total);
    } catch (caught) { setError(errorText(caught, "Could not load more transcript.")); }
    finally { setTranscriptLoading(false); }
  }, [detail, ops, transcriptLoading, transcriptNext]);

  const setScope = useCallback(async (scope: MeetingScope, options?: { teamId?: string }) => {
    if (!detail || busy) return;
    setBusy("share");
    setError("");
    try {
      const share = await ops.setScope(detail.id, scope, options);
      setDetail((current) => current ? { ...current, share } : current);
      setItems((list) => list.map((item) => item.id === detail.id ? { ...item, scope } : item));
    } catch (caught) { setError(errorText(caught, "Could not change meeting access.")); }
    finally { setBusy(""); }
  }, [busy, detail, ops]);

  const toggleAction = useCallback(async (action: MeetingActionItem) => {
    if (!detail || busy) return;
    const done = !action.done;
    const previous = detail.actionItems;
    setBusy(`action:${action.id}`);
    setDetail({ ...detail, actionItems: previous.map((item) => item.id === action.id ? { ...item, done } : item) });
    setError("");
    try { await ops.toggleAction(detail.id, action.id, done); }
    catch (caught) { setDetail((current) => current ? { ...current, actionItems: previous } : current); setError(errorText(caught, "Could not update that action item.")); }
    finally { setBusy(""); }
  }, [busy, detail, ops]);

  const toggleTrack = useCallback(async (action: MeetingActionItem) => {
    if (!detail || busy) return;
    const previous = detail.actionItems;
    setBusy(`track:${action.id}`);
    setError("");
    try {
      if (action.trackItemId) {
        await ops.unsendActionFromTrack(detail.id, action.id);
        setDetail((current) => current ? { ...current, actionItems: current.actionItems.map((item) => item.id === action.id ? { ...item, trackItemId: undefined } : item) } : current);
      } else {
        const { trackItemId } = await ops.sendActionToTrack(detail.id, action.id);
        setDetail((current) => current ? { ...current, actionItems: current.actionItems.map((item) => item.id === action.id ? { ...item, trackItemId } : item) } : current);
      }
    } catch (caught) { setDetail((current) => current ? { ...current, actionItems: previous } : current); setError(errorText(caught, "Could not update Meeting Track.")); }
    finally { setBusy(""); }
  }, [busy, detail, ops]);

  const regenerate = useCallback(async () => {
    if (!detail || busy) return;
    setBusy("regenerate");
    setError("");
    try { const updated = await ops.regenerateSummary(detail.id); setDetail(updated); setDraftSummary(updated.summaryMarkdown); }
    catch (caught) { setError(errorText(caught, "Could not regenerate this summary.")); }
    finally { setBusy(""); }
  }, [busy, detail, ops]);

  const saveSummary = useCallback(async () => {
    if (!detail || busy) return;
    setBusy("save-summary");
    setError("");
    try { const updated = await ops.updateSummary(detail.id, draftSummary); setDetail(updated); setEditing(false); }
    catch (caught) { setError(errorText(caught, "Could not save this summary.")); }
    finally { setBusy(""); }
  }, [busy, detail, draftSummary, ops]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => (scopeFilter === "all" || item.scope === scopeFilter) && (!needle || item.title.toLowerCase().includes(needle)));
  }, [items, query, scopeFilter]);

  return (
    <div className="mv-shell">
      <div className="mv-tabs" role="tablist" aria-label="Meetings sections">
        {(["meetings", "tracked", "teams"] as const).map((tab) => <button type="button" key={tab} role="tab" aria-selected={mode === tab} className={`mv-tab${mode === tab ? " mv-on" : ""}`} onClick={() => setMode(tab)}>{tab === "tracked" ? "Track" : tab[0].toUpperCase() + tab.slice(1)}</button>)}
      </div>
      {mode === "tracked" ? <MeetingTracksView ops={ops} /> : mode === "teams" ? <TeamsView ops={teamsOps} onChanged={() => setTeamRevision((value) => value + 1)} /> : (
        <div className="mv-root">
          <aside className={`mv-col${selectedId || composing ? " mv-col-has-selection" : ""}`}>
            <div className="mv-col-head"><div><span className="mv-eyebrow">Library</span><h2>Meetings <span>{items.length}</span></h2></div><button type="button" className="mv-newbtn" onClick={() => { setComposing(true); setSelectedId(null); }}>+ New</button></div>
            <label className="mv-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search meetings" aria-label="Search meetings" />{query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search">×</button> : null}</label>
            <div className="mv-scope-filters" role="group" aria-label="Filter meeting visibility">{(["all", ...MEETING_SCOPES] as const).map((scope) => <button type="button" key={scope} className={scopeFilter === scope ? "mv-on" : ""} aria-pressed={scopeFilter === scope} onClick={() => setScopeFilter(scope)}>{scope === "org" ? "Org" : scope[0].toUpperCase() + scope.slice(1)}</button>)}</div>
            {error ? <div className="mv-list-error" role="alert">{error}<button type="button" onClick={() => void refreshList()}>Retry</button></div> : null}
            <div className="mv-items">
              {filtered.map((item) => <button type="button" key={item.id} className={`mv-item${!composing && item.id === selectedId ? " mv-on" : ""}`} onClick={() => { setComposing(false); setSelectedId(item.id); }} aria-pressed={!composing && item.id === selectedId}><span className="mv-item-t">{item.title}</span><span className="mv-item-m"><span className="mv-item-d">{item.date}</span><span className={`mv-summary-dot mv-summary-${item.summaryStatus}`} title={`Summary ${item.summaryStatus}`} /><ScopeBadge scope={item.scope} />{!item.canEdit ? <span className="mv-shared-readonly">Shared</span> : null}</span></button>)}
              {!filtered.length ? <div className="mv-state">{loading ? "Loading meetings…" : items.length ? "No meetings match these filters." : "No meetings yet. Record, import audio, or paste a transcript to begin."}</div> : null}
            </div>
            {nextCursor ? <button type="button" className="mv-load-more" disabled={busy === "more-meetings"} onClick={() => void loadMoreMeetings()}>{busy === "more-meetings" ? "Loading…" : "Load more meetings"}</button> : null}
          </aside>

          {composing ? <NewMeeting ops={ops} onCancel={() => { setComposing(false); void refreshList(); }} onCreated={async (id) => { await refreshList(); setComposing(false); setSelectedId(id); }} /> : detail ? (
            <main className="mv-detail">
              <button type="button" className="mv-mobile-back" onClick={() => setSelectedId(null)}>← Meetings</button>
              {error ? <div className="mv-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}
              <header className="mv-dhead">
                <div className="mv-dhead-row"><div className="mv-title-block"><div className="mv-title-status"><span className={`mv-summary-dot mv-summary-${detail.summaryStatus}`} />{STATUS_LABEL[detail.summaryStatus]}</div><h3>{detail.title}</h3><div className="mv-att"><span className="mv-av">{detail.attendees.slice(0, 4).map((attendee) => <span key={attendee}>{initials(attendee)}</span>)}</span>{detail.attendees.length ? detail.attendees.join(", ") : "No attendees recorded"}</div></div><div className="mv-hactions">{detail.canEdit ? <SharePopover share={detail.share} busy={busy === "share"} teamsOps={teamsOps} teamRevision={teamRevision} onError={setError} onSetScope={(scope, options) => void setScope(scope, options)} /> : <span className="mv-shared-readonly">Shared with you · read only</span>}{detail.model ? <span className="mv-modelchip">{detail.model.label}{detail.model.effort ? <> · <b>{detail.model.effort}</b></> : null}</span> : null}</div></div>
                <div className="mv-metastrip"><span className="mv-chip">{detail.status || "Captured"}</span><span className="mv-chip">{detail.date}</span>{detail.durationMin ? <span className="mv-chip">{detail.durationMin} min</span> : null}{detail.wordCount ? <span className="mv-chip">{detail.wordCount.toLocaleString()} words</span> : null}</div>
              </header>
              <div className="mv-dbody">
                <div className="mv-colL">
                  {detail.summaryStatus === "failed" ? <div className="mv-summary-failed"><strong>Summary generation failed</strong><span>{detail.summaryError || (detail.canEdit ? "The transcript is preserved. Try generating the summary again." : "The transcript is preserved. The owner can generate the summary again.")}</span>{detail.canEdit ? <button type="button" className="mv-secondary" onClick={() => void regenerate()}>Try again</button> : null}</div> : null}
                  <section className="mv-card"><div className="mv-card-lab"><span>Summary</span><div className="mv-cardacts">{editing ? <><button type="button" className="mv-ghost" onClick={() => { setEditing(false); setDraftSummary(detail.summaryMarkdown); }}>Cancel</button><button type="button" className="mv-ghost mv-ghost-strong" disabled={busy === "save-summary"} onClick={() => void saveSummary()}>{busy === "save-summary" ? "Saving…" : "Save"}</button></> : <>{detail.canEdit ? <><button type="button" className="mv-ghost" disabled={busy === "regenerate"} onClick={() => void regenerate()}>{busy === "regenerate" ? "Generating…" : "Regenerate"}</button><button type="button" className="mv-ghost" onClick={() => { setDraftSummary(detail.summaryMarkdown); setEditing(true); }}>Edit</button></> : null}<button type="button" className="mv-ghost" onClick={() => { void navigator.clipboard?.writeText(detail.summaryMarkdown); setCopied(true); globalThis.setTimeout(() => setCopied(false), 1400); }}>{copied ? "Copied" : "Copy"}</button></>}</div></div>{editing ? <textarea className="mv-summary-editor" value={draftSummary} onChange={(event) => setDraftSummary(event.target.value)} aria-label="Meeting summary" /> : detail.summaryStatus === "queued" || detail.summaryStatus === "processing" ? <div className="mv-processing"><span />Generating a recallable summary. You can leave this page.</div> : detail.summaryMarkdown ? <SummaryBody markdown={detail.summaryMarkdown} /> : <div className="mv-state">No summary is available yet.</div>}</section>
                  <section className="mv-card"><div className="mv-card-lab"><span>Action items</span><span>{detail.actionItems.length}</span></div>{detail.actionItems.length ? detail.actionItems.map((action) => <div className="mv-ai" key={action.id}><button type="button" className={`mv-cbox${action.done ? " mv-done" : ""}`} disabled={!detail.canEdit || busy === `action:${action.id}`} aria-label={action.done ? "Mark not done" : "Mark done"} onClick={() => void toggleAction(action)}>✓</button><div className="mv-txt"><span className={action.done ? "mv-action-done" : ""}>{action.title}</span>{action.assignee ? <small>→ {action.assignee}</small> : null}</div>{detail.canEdit ? <button type="button" className={`mv-totrack${action.trackItemId ? " mv-linked" : ""}`} disabled={busy === `track:${action.id}`} onClick={() => void toggleTrack(action)}>{busy === `track:${action.id}` ? "Updating…" : action.trackItemId ? "In Track ✓" : "Track ↗"}</button> : null}</div>) : <div className="mv-state mv-state-compact">No action items were detected.</div>}</section>
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

function NewMeeting({ ops, onCreated, onCancel }: { ops: MeetingsOps; onCreated(id: string): Promise<void>; onCancel(): void }): ReactElement {
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [template, setTemplate] = useState<CreateMeetingInput["template"]>("general");
  const [language, setLanguage] = useState("auto");
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [recovered, setRecovered] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as { title?: string; transcript?: string; template?: CreateMeetingInput["template"]; language?: string } | null;
      if (saved?.title) setTitle(saved.title); if (saved?.transcript) setTranscript(saved.transcript); if (saved?.template) setTemplate(saved.template); if (saved?.language) setLanguage(saved.language);
      setRecovered(Boolean(saved?.title || saved?.transcript));
    } catch { /* ignore invalid local drafts */ }
  }, []);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      if (title || transcript) localStorage.setItem(DRAFT_KEY, JSON.stringify({ title, transcript, template, language })); else localStorage.removeItem(DRAFT_KEY);
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [language, template, title, transcript]);
  useEffect(() => () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") { recorderRef.current.onstop = null; recorderRef.current.stop(); }
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const transcribe = useCallback(async (blob: Blob) => {
    setBusy("transcribe"); setError("");
    try {
      if (!blob.size) throw new Error("The selected audio file is empty.");
      if (blob.size > MAX_AUDIO_BYTES) throw new Error("Audio must be 40 MB or smaller.");
      const result = await ops.transcribeAudio({ bytes: new Uint8Array(await blob.arrayBuffer()), contentType: blob.type || "audio/webm", ...(language === "auto" ? {} : { language }) });
      if (!result.text.trim()) throw new Error("No speech was detected in that audio.");
      setTranscript((current) => current ? `${current}\n${result.text.trim()}` : result.text.trim());
    } catch (caught) { setError(errorText(caught, "Could not transcribe that audio.")); }
    finally { setBusy(""); }
  }, [language, ops]);

  const startRecording = useCallback(async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      streamRef.current = stream; recorderRef.current = recorder; chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => { stream.getTracks().forEach((track) => track.stop()); streamRef.current = null; void transcribe(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" })); };
      recorder.start(); setRecording(true); setPaused(false);
    } catch { setError("Microphone access was denied or is unavailable."); }
  }, [transcribe]);
  const stopRecording = useCallback(() => { recorderRef.current?.stop(); recorderRef.current = null; setRecording(false); setPaused(false); }, []);
  const togglePause = useCallback(() => { const recorder = recorderRef.current; if (!recorder) return; if (recorder.state === "recording") { recorder.pause(); setPaused(true); } else if (recorder.state === "paused") { recorder.resume(); setPaused(false); } }, []);
  const importAudio = useCallback((event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) void transcribe(file); event.target.value = ""; }, [transcribe]);

  const submit = useCallback(async () => {
    if (!title.trim() || !transcript.trim() || busy) return;
    setBusy("create"); setError("");
    try {
      const result = await ops.createFromTranscript({ title: title.trim(), transcript, template });
      localStorage.removeItem(DRAFT_KEY); await onCreated(result.id);
    } catch (caught) { setError(errorText(caught, "Could not create this meeting.")); }
    finally { setBusy(""); }
  }, [busy, onCreated, ops, template, title, transcript]);

  return <main className="mv-detail"><button type="button" className="mv-mobile-back" onClick={onCancel}>← Meetings</button><div className="mv-compose"><div className="mv-compose-head"><div><span className="mv-eyebrow">Capture</span><h3>New meeting</h3><p>Record, import audio, or paste a transcript. Your draft stays on this device until it is summarized.</p></div>{recovered ? <span className="mv-recovered">Draft recovered</span> : null}</div>{error ? <div className="mv-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}<div className="mv-capture-bar">{recording ? <><button type="button" className="mv-recording" onClick={stopRecording}><span /> Stop & transcribe</button><button type="button" className="mv-secondary" onClick={togglePause}>{paused ? "Resume" : "Pause"}</button></> : <button type="button" className="mv-secondary" onClick={() => void startRecording()} disabled={Boolean(busy)}>● Record audio</button>}<label className={`mv-secondary mv-file-btn${busy ? " mv-disabled" : ""}`}>↑ Import audio<input type="file" accept="audio/*" onChange={importAudio} disabled={Boolean(busy)} /></label><span>{busy === "transcribe" ? "Transcribing audio…" : "MP3, M4A, WAV, or WebM · up to 40 MB"}</span></div><div className="mv-compose-grid"><label className="mv-field mv-field-wide"><span>Meeting title</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Weekly product sync" maxLength={180} /></label><label className="mv-field"><span>Summary template</span><select value={template} onChange={(event) => setTemplate(event.target.value as CreateMeetingInput["template"])}><option value="general">General</option><option value="standup">Stand-up</option><option value="one-on-one">1:1</option><option value="retrospective">Retrospective</option></select></label><label className="mv-field"><span>Audio language</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="auto">Auto-detect</option><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="ja">Japanese</option></select></label><label className="mv-field mv-field-wide"><span>Transcript</span><textarea value={transcript} onChange={(event) => setTranscript(event.target.value)} placeholder="Paste a transcript here, or record/import audio above…" /></label></div><div className="mv-compose-actions"><button type="button" className="mv-primary" disabled={!title.trim() || !transcript.trim() || Boolean(busy)} onClick={() => void submit()}>{busy === "create" ? "Creating & summarizing…" : "Create meeting"}</button><button type="button" className="mv-secondary" onClick={onCancel}>Cancel</button></div></div></main>;
}
