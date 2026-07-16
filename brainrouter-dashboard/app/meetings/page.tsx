"use client";

/**
 * Meetings — the dashboard mirror of the desktop Meetings mode (ADR-018). Lists the
 * account's recallable meeting summaries and shows a detail with the same model +
 * four-level sharing vocabulary (Private / Team / Org / Public). Real, org-scoped
 * data from the backend at :3747 (/api/meetings) using the signed-in account's JWT
 * — the same dataset the desktop sees for the same account. No sample data.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Lock, UsersThree, Buildings, GlobeHemisphereWest, Microphone, type Icon } from "@phosphor-icons/react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { InlineLoading } from "../../components/LoadingSpinner";
import { adminApi, authFetch, type Team } from "../../lib/adminApi";
import { BASE_URL } from "../../lib/client";
import { getApiKey, getJwt } from "../../lib/client-auth";
import { invalidateDashboardQueries, queryDashboard } from "../../lib/dashboardQuery";
import styles from "./meetings.module.css";

type Scope = "private" | "team" | "org" | "public";
type SummaryStatus = "queued" | "processing" | "ready" | "failed";
interface ListItem { id: string; title: string; date: string; scope: Scope; attendeeCount: number; summaryStatus: SummaryStatus }
interface ActionItem { id: string; title: string; assignee?: string; done?: boolean; trackItemId?: string }
interface Share { scope: Scope; teamId?: string; publicUrl?: string; expiresAt?: string }
interface Detail {
  id: string; title: string; date: string; status: string; durationMin?: number; wordCount?: number;
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
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [loading, setLoading] = useState(true);
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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("brainrouter:meeting-draft") ?? "null") as { title?: string; transcript?: string; language?: string; template?: string } | null;
      if (saved?.title) setDraftTitle(saved.title);
      if (saved?.transcript) setDraftTranscript(saved.transcript);
      if (saved?.language) setLanguage(saved.language);
      if (saved?.template) setSummaryTemplate(saved.template);
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
        const overview = await authFetch<Overview>(`/api/meetings/${id}/overview`);
        if (!alive) return;
        setDetail((cur) => (cur && cur.id === id ? { ...cur, ...overview } : cur));
        setItems((list) => list.map((m) => (m.id === id ? { ...m, summaryStatus: overview.summaryStatus } : m)));
      } catch { /* transient — keep polling */ }
    }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [detail?.id, detail?.summaryStatus]);

  const saveSummary = useCallback(async () => {
    if (!detail) return;
    setBusy("save-summary");
    try {
      const d = await authFetch<Detail>(`/api/meetings/${detail.id}/summary`, { method: "PATCH", body: { summaryMarkdown: draftSummary } });
      invalidateDashboardQueries(`meetings:overview:${detail.id}`);
      setDetail(d);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the summary.");
    } finally {
      setBusy("");
    }
  }, [detail, draftSummary]);

  const transcribe = useCallback(async (blob: Blob) => {
    setBusy("transcribe");
    setCreateErr("");
    try {
      const token = getJwt() || getApiKey() || "";
      const res = await fetch(`${BASE_URL}/v1/audio/transcriptions${language === "auto" ? "" : `?language=${encodeURIComponent(language)}`}`, {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: blob,
      });
      if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
      const out = (await res.json()) as { text?: string };
      const text = (out.text ?? "").trim();
      if (text) setDraftTranscript((cur) => (cur ? `${cur}\n${text}` : text));
      else setCreateErr("No speech was detected in the recording.");
    } catch (caught) {
      setCreateErr(caught instanceof Error ? caught.message : "Transcription failed.");
    } finally {
      setBusy("");
    }
  }, [language]);

  const startRecording = useCallback(async () => {
    setCreateErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void transcribe(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }));
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecordingPaused(false);
    } catch {
      setCreateErr("Microphone access was denied or is unavailable.");
    }
  }, [transcribe]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
    setRecordingPaused(false);
  }, []);

  const toggleRecordingPause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") { recorder.pause(); setRecordingPaused(true); }
    else if (recorder.state === "paused") { recorder.resume(); setRecordingPaused(false); }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await queryDashboard("meetings:list", () => authFetch<{ meetings: ListItem[]; nextCursor: string | null }>("/api/meetings?limit=50"), { ttlMs: 30_000 });
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
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadMoreMeetings = useCallback(async () => {
    if (!meetingsNext || busy === "more-meetings") return;
    setBusy("more-meetings");
    try {
      const page = await authFetch<{ meetings: ListItem[]; nextCursor: string | null }>(`/api/meetings?limit=50&cursor=${encodeURIComponent(meetingsNext)}`);
      setItems((current) => [...current, ...page.meetings.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setMeetingsNext(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more meetings.");
    } finally {
      setBusy("");
    }
  }, [meetingsNext, busy]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const controller = new AbortController();
    const id = selectedId;
    setDetail(null);
    setTeamPickerOpen(false);
    setTranscriptSegments([]);
    setTranscriptNext(null);
    setTranscriptTotal(0);
    setTranscriptLoading(true);
    void queryDashboard(`meetings:overview:${id}`, () => authFetch<Overview>(`/api/meetings/${id}/overview`, { signal: controller.signal }), { ttlMs: 30_000 }).then((overview) => {
      if (!controller.signal.aborted) { setDetail({ ...overview, transcript: [] }); setShareOpen(false); }
    }).catch(() => { if (!controller.signal.aborted) setDetail(null); });
    void authFetch<TranscriptPage>(`/api/meetings/${id}/transcript?limit=100`, { signal: controller.signal }).then((page) => {
      if (controller.signal.aborted) return;
      setTranscriptSegments(page.segments);
      setTranscriptNext(page.nextCursor);
      setTranscriptTotal(page.total);
    }).catch(() => {}).finally(() => { if (!controller.signal.aborted) setTranscriptLoading(false); });
    return () => controller.abort();
  }, [selectedId]);

  const loadMoreTranscript = useCallback(async () => {
    if (!detail || !transcriptNext || transcriptLoading) return;
    const id = detail.id;
    setTranscriptLoading(true);
    try {
      const page = await authFetch<TranscriptPage>(`/api/meetings/${id}/transcript?limit=100&cursor=${encodeURIComponent(transcriptNext)}`);
      if (detail.id === id) setTranscriptSegments((current) => [...current, ...page.segments]);
      setTranscriptNext(page.nextCursor);
      setTranscriptTotal(page.total);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more transcript.");
    } finally {
      setTranscriptLoading(false);
    }
  }, [detail, transcriptNext, transcriptLoading]);

  // Load the caller's teams (active org) lazily the first time the share menu
  // opens — most meetings never get shared to a team, so we don't fetch on load.
  const loadTeams = useCallback(async () => {
    try {
      const r = await queryDashboard("teams:list", () => adminApi.listTeams(), { ttlMs: 30_000 });
      setTeams(r.teams ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load teams.");
    } finally {
      setTeamsLoaded(true);
    }
  }, []);

  useEffect(() => { if (shareOpen && !teamsLoaded) void loadTeams(); }, [shareOpen, teamsLoaded, loadTeams]);

  // Team scope REQUIRES a teamId (the backend 400s without one). Selecting the
  // Team row with no team chosen just reveals the picker; a concrete team POSTs.
  const setScope = useCallback(async (scope: Scope, teamId?: string) => {
    if (!detail) return;
    if (scope === "team" && !teamId) { setTeamPickerOpen(true); return; }
    try {
      const body = scope === "team" ? { scope, teamId } : { scope };
      const share = await authFetch<Share>(`/api/meetings/${detail.id}/scope`, { method: "POST", body });
      invalidateDashboardQueries(`meetings:overview:${detail.id}`);
      setDetail((d) => (d ? { ...d, share } : d));
      setItems((list) => list.map((m) => (m.id === detail.id ? { ...m, scope } : m)));
      if (scope !== "team") setTeamPickerOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change sharing.");
    }
  }, [detail]);

  const createTeamInline = useCallback(async () => {
    const name = newTeamName.trim();
    if (!name) return;
    setBusy("create-team");
    try {
      const { team } = await adminApi.createTeam(name);
      invalidateDashboardQueries("teams:");
      setTeams((cur) => [...cur, team]);
      setNewTeamName("");
      await setScope("team", team.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the team.");
    } finally {
      setBusy("");
    }
  }, [newTeamName, setScope]);

  const regenerate = useCallback(async () => {
    if (!detail) return;
    setBusy("regen");
    try {
      const d = await authFetch<Detail>(`/api/meetings/${detail.id}/regenerate`, { method: "POST" });
      invalidateDashboardQueries(`meetings:overview:${detail.id}`);
      setDetail(d);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not regenerate the summary.");
    } finally {
      setBusy("");
    }
  }, [detail]);

  const toggleAction = useCallback(async (action: ActionItem) => {
    if (!detail) return;
    const done = !action.done;
    try {
      await authFetch(`/api/meetings/${detail.id}/actions/${action.id}`, { method: "POST", body: { done } });
      invalidateDashboardQueries(`meetings:overview:${detail.id}`);
      setDetail((d) => (d ? { ...d, actionItems: d.actionItems.map((x) => (x.id === action.id ? { ...x, done } : x)) } : d));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the action item.");
    }
  }, [detail]);

  // Track / untrack a meeting action — creates (or removes) a real Track work item
  // server-side, so it shows up on the Track board here and on the desktop.
  const toggleTrack = useCallback(async (action: ActionItem) => {
    if (!detail) return;
    const linked = Boolean(action.trackItemId);
    try {
      if (linked) {
        await authFetch(`/api/meetings/${detail.id}/actions/${action.id}/track`, { method: "DELETE" });
        setDetail((d) => (d ? { ...d, actionItems: d.actionItems.map((x) => (x.id === action.id ? { ...x, trackItemId: undefined } : x)) } : d));
      } else {
        const res = await authFetch<{ trackItemId: string }>(`/api/meetings/${detail.id}/actions/${action.id}/track`, { method: "POST" });
        setDetail((d) => (d ? { ...d, actionItems: d.actionItems.map((x) => (x.id === action.id ? { ...x, trackItemId: res.trackItemId } : x)) } : d));
      }
      invalidateDashboardQueries(`meetings:overview:${detail.id}`);
      invalidateDashboardQueries("track:");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update Track.");
    }
  }, [detail]);

  const submitCreate = useCallback(async () => {
    if (!draftTitle.trim() || !draftTranscript.trim()) { setCreateErr("A title and a transcript are required."); return; }
    setBusy("create");
    setCreateErr("");
    try {
      const out = await authFetch<{ id: string }>("/api/meetings", { method: "POST", body: { title: draftTitle.trim(), transcript: draftTranscript, template: summaryTemplate } });
      invalidateDashboardQueries("meetings:");
      setCreateOpen(false);
      setDraftTitle("");
      setDraftTranscript("");
      localStorage.removeItem("brainrouter:meeting-draft");
      await load();
      setSelectedId(out.id);
    } catch (caught) {
      setCreateErr(caught instanceof Error ? caught.message : "Could not create the meeting.");
    } finally {
      setBusy("");
    }
  }, [draftTitle, draftTranscript, summaryTemplate, load]);

  const summaryBlocks = useMemo(() => renderSummary(detail?.summaryMarkdown ?? ""), [detail?.summaryMarkdown]);

  return (
    <AuthGuard>
      <PageHeader title="Meetings" description="Recallable meeting summaries across your organization." />
      <div className={styles.page}>
      {error ? <div className={styles.errorBar} role="alert">{error}</div> : null}
      <div className={styles.wrap}>
        <div className={styles.list}>
          <div className={styles.listHead}>
            <h2>Meetings</h2>
            <button type="button" className={styles.newBtn} onClick={() => { setCreateErr(""); setCreateOpen(true); }}>+ New</button>
          </div>
          {items.map((m) => (
            <div key={m.id} className={`${styles.item}${m.id === selectedId ? ` ${styles.itemOn}` : ""}`} onClick={() => setSelectedId(m.id)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") setSelectedId(m.id); }}>
              <div className={styles.itemT}>{m.title}</div>
              <div className={styles.itemM}><span className={styles.itemD}>{m.date}</span><ScopeBadge scope={m.scope} /></div>
            </div>
          ))}
          {items.length === 0 ? (
            <div className={styles.empty}>{loading ? "Loading…" : "No meetings yet. Click + New to add one."}</div>
          ) : null}
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
                  <button type="button" className={styles.shareBtn} onClick={() => setShareOpen((v) => !v)} aria-haspopup="menu" aria-expanded={shareOpen}>
                    <span className={`${styles.dot} ${SCOPE_META[detail.share.scope].dot}`} />
                    {SCOPE_META[detail.share.scope].label}
                    {detail.share.scope === "team" && detail.share.teamId ? ` · ${teams.find((t) => t.id === detail.share.teamId)?.name ?? "Team"}` : ""} ▾
                  </button>
                  {detail.model ? <span className={styles.modelChip}>{detail.model.label}{detail.model.effort ? <> · <b>{detail.model.effort}</b></> : null}</span> : null}
                  {shareOpen ? (
                    <div className={styles.pop} role="menu">
                      <div className={styles.popH}>Who can access</div>
                      {SCOPES.map((s) => {
                        const ScopeIcon = SCOPE_META[s].Icon;
                        return (
                          <button key={s} type="button" className={`${styles.srow}${detail.share.scope === s ? ` ${styles.srowOn}` : ""}`} onClick={() => void setScope(s)} role="menuitemradio" aria-checked={detail.share.scope === s}>
                            <span className={styles.srowIc}><ScopeIcon size={16} /></span>
                            <span><span className={styles.srowLb}>{SCOPE_META[s].label}</span><span className={styles.srowDs}>{SCOPE_META[s].blurb}</span></span>
                          </button>
                        );
                      })}
                      {teamPickerOpen || detail.share.scope === "team" ? (
                        <div className={styles.linkzone}>
                          {!teamsLoaded ? (
                            <InlineLoading label="Loading teams…" />
                          ) : teams.length === 0 ? (
                            <>
                              <div className={styles.teamPickH}>You have no teams yet — create one to share with your team.</div>
                              <div className={styles.teamCreateRow}>
                                <input value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} placeholder="Team name (e.g. Platform)" aria-label="New team name" onKeyDown={(e) => { if (e.key === "Enter") void createTeamInline(); }} />
                                <button type="button" onClick={() => void createTeamInline()} disabled={busy === "create-team" || !newTeamName.trim()}>{busy === "create-team" ? "Creating…" : "Create"}</button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className={styles.teamPickH}>Share with team</div>
                              <select className={styles.teamSel} value={detail.share.teamId ?? ""} onChange={(e) => { if (e.target.value) void setScope("team", e.target.value); }} aria-label="Share with team">
                                <option value="" disabled>Select a team…</option>
                                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                              </select>
                            </>
                          )}
                        </div>
                      ) : null}
                      {detail.share.scope === "public" && detail.share.publicUrl ? (
                        <div className={styles.linkzone}>
                          <div className={styles.linkrow}>
                            <input readOnly value={detail.share.publicUrl} aria-label="Public link" />
                            <button type="button" onClick={() => void navigator.clipboard?.writeText(detail.share.publicUrl ?? "")}>Copy</button>
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
                <button type="button" className={styles.chip} onClick={() => void regenerate()}
                  disabled={busy === "regen" || detail.summaryStatus === "processing" || detail.summaryStatus === "queued"} style={{ cursor: "pointer" }}>
                  {detail.summaryStatus === "processing" || detail.summaryStatus === "queued" ? "● Summarizing…" : busy === "regen" ? "Regenerating…" : "↻ Regenerate"}
                </button>
              </div>
            </div>
            <div className={styles.body}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                <div className={styles.card}>
                  <div className={styles.cardLab} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>Summary</span>
                    {detail.summaryStatus === "ready" && !editing ? (
                      <button type="button" className={styles.track} onClick={() => { setDraftSummary(detail.summaryMarkdown); setEditing(true); }}>✎ Edit</button>
                    ) : null}
                  </div>
                  {detail.summaryStatus === "processing" || detail.summaryStatus === "queued" ? (
                    <div className={styles.empty}>● Generating notes… this keeps running on the server — you can leave or refresh.</div>
                  ) : detail.summaryStatus === "failed" ? (
                    <div className={styles.errorBar} role="alert">{(detail.summaryError || "Summary generation failed.") + " Check the meeting-summary model, then Regenerate."}</div>
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
                        <label className={styles.aiTxt} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                          <input type="checkbox" checked={Boolean(a.done)} onChange={() => void toggleAction(a)} style={{ marginTop: 3 }} />
                          <span style={a.done ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>
                            {a.title}{a.assignee ? <span className={styles.aiWho}>→ {a.assignee}</span> : null}
                          </span>
                        </label>
                        <button type="button" className={styles.track} title={a.trackItemId ? "Remove from Track" : "Add to Track"} onClick={() => void toggleTrack(a)}>{a.trackItemId ? "In Track ✓" : "Track ↗"}</button>
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
          <div className={styles.detail}><div className={styles.empty}>{items.length ? "Select a meeting." : "No meeting selected."}</div></div>
        )}
      </div>

      {createOpen ? (
        <div className={styles.modalScrim} role="dialog" aria-modal="true" aria-label="New meeting" onClick={() => setCreateOpen(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.cardLab}>New meeting</div>
            <input
              className={styles.modalInput}
              placeholder="Title (e.g. Weekly product sync)"
              value={draftTitle}
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
              <span>{draftTranscript ? "Draft recovered automatically" : "Drafts are saved on this device"}</span>
            </div>
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
