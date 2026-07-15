"use client";

/**
 * Meetings — the dashboard mirror of the desktop Meetings mode (ADR-018). Lists the
 * account's recallable meeting summaries and shows a detail with the same model +
 * four-level sharing vocabulary (Private / Team / Org / Public). Real, org-scoped
 * data from the backend at :3747 (/api/meetings) using the signed-in account's JWT
 * — the same dataset the desktop sees for the same account. No sample data.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { authFetch } from "../../lib/adminApi";
import { BASE_URL } from "../../lib/client";
import { getApiKey, getJwt } from "../../lib/client-auth";
import styles from "./meetings.module.css";

type Scope = "private" | "team" | "org" | "public";
interface ListItem { id: string; title: string; date: string; scope: Scope; attendeeCount: number }
interface ActionItem { id: string; title: string; assignee?: string; done?: boolean; trackItemId?: string }
interface Share { scope: Scope; teamId?: string; publicUrl?: string; expiresAt?: string }
interface Detail {
  id: string; title: string; date: string; status: string; durationMin?: number; wordCount?: number;
  attendees: string[]; model?: { label: string; effort?: string };
  summaryMarkdown: string; actionItems: ActionItem[];
  transcript: { at: string; speaker: string; text: string }[];
  share: Share;
}

const SCOPE_META: Record<Scope, { label: string; blurb: string; badge: string; dot: string; icon: string }> = {
  private: { label: "Private", blurb: "Only you can see this meeting.", badge: styles.bPrivate, dot: "", icon: "🔒" },
  team: { label: "Team", blurb: "Members of your team can recall it.", badge: styles.bTeam, dot: styles.dotTeam, icon: "◑" },
  org: { label: "Organization", blurb: "Everyone in your organization.", badge: styles.bOrg, dot: styles.dotOrg, icon: "▤" },
  public: { label: "Public", blurb: "Anyone with the link — redacted summary only.", badge: styles.bPublic, dot: styles.dotPublic, icon: "◍" },
};
const SCOPES: Scope[] = ["private", "team", "org", "public"];

function ScopeBadge({ scope }: { scope: Scope }) {
  const m = SCOPE_META[scope];
  return <span className={`${styles.badge} ${m.badge}`}>{scope === "org" ? "Org" : m.label}</span>;
}

export default function MeetingsPage() {
  const [items, setItems] = useState<ListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTranscript, setDraftTranscript] = useState("");
  const [createErr, setCreateErr] = useState("");
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const transcribe = useCallback(async (blob: Blob) => {
    setBusy("transcribe");
    setCreateErr("");
    try {
      const token = getJwt() || getApiKey() || "";
      const res = await fetch(`${BASE_URL}/v1/audio/transcriptions`, {
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
  }, []);

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
    } catch {
      setCreateErr("Microphone access was denied or is unavailable.");
    }
  }, [transcribe]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch<{ meetings: ListItem[] }>("/api/meetings");
      const list = r.meetings ?? [];
      setItems(list);
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

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let live = true;
    void (async () => {
      try {
        const d = await authFetch<Detail>(`/api/meetings/${selectedId}`);
        if (live) { setDetail(d); setShareOpen(false); }
      } catch {
        if (live) setDetail(null);
      }
    })();
    return () => { live = false; };
  }, [selectedId]);

  const setScope = useCallback(async (scope: Scope) => {
    if (!detail) return;
    try {
      const share = await authFetch<Share>(`/api/meetings/${detail.id}/scope`, { method: "POST", body: { scope } });
      setDetail((d) => (d ? { ...d, share } : d));
      setItems((list) => list.map((m) => (m.id === detail.id ? { ...m, scope } : m)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change sharing.");
    }
  }, [detail]);

  const regenerate = useCallback(async () => {
    if (!detail) return;
    setBusy("regen");
    try {
      const d = await authFetch<Detail>(`/api/meetings/${detail.id}/regenerate`, { method: "POST" });
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
      setDetail((d) => (d ? { ...d, actionItems: d.actionItems.map((x) => (x.id === action.id ? { ...x, done } : x)) } : d));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the action item.");
    }
  }, [detail]);

  const submitCreate = useCallback(async () => {
    if (!draftTitle.trim() || !draftTranscript.trim()) { setCreateErr("A title and a transcript are required."); return; }
    setBusy("create");
    setCreateErr("");
    try {
      const out = await authFetch<{ id: string }>("/api/meetings", { method: "POST", body: { title: draftTitle.trim(), transcript: draftTranscript } });
      setCreateOpen(false);
      setDraftTitle("");
      setDraftTranscript("");
      await load();
      setSelectedId(out.id);
    } catch (caught) {
      setCreateErr(caught instanceof Error ? caught.message : "Could not create the meeting.");
    } finally {
      setBusy("");
    }
  }, [draftTitle, draftTranscript, load]);

  const summaryBlocks = useMemo(() => renderSummary(detail?.summaryMarkdown ?? ""), [detail?.summaryMarkdown]);

  return (
    <AuthGuard>
      <PageHeader title="Meetings" description="Recallable meeting summaries across your organization." />
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
                    {SCOPE_META[detail.share.scope].label} ▾
                  </button>
                  {detail.model ? <span className={styles.modelChip}>{detail.model.label}{detail.model.effort ? <> · <b>{detail.model.effort}</b></> : null}</span> : null}
                  {shareOpen ? (
                    <div className={styles.pop} role="menu">
                      <div className={styles.popH}>Who can access</div>
                      {SCOPES.map((s) => (
                        <button key={s} type="button" className={`${styles.srow}${detail.share.scope === s ? ` ${styles.srowOn}` : ""}`} onClick={() => void setScope(s)} role="menuitemradio" aria-checked={detail.share.scope === s}>
                          <span className={styles.srowIc}>{SCOPE_META[s].icon}</span>
                          <span><span className={styles.srowLb}>{SCOPE_META[s].label}</span><span className={styles.srowDs}>{SCOPE_META[s].blurb}</span></span>
                        </button>
                      ))}
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
                <button type="button" className={styles.chip} onClick={() => void regenerate()} disabled={busy === "regen"} style={{ cursor: "pointer" }}>
                  {busy === "regen" ? "Regenerating…" : "↻ Regenerate"}
                </button>
              </div>
            </div>
            <div className={styles.body}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                <div className={styles.card}>
                  <div className={styles.cardLab}>Summary</div>
                  {summaryBlocks}
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
                        <button type="button" className={styles.track} disabled={Boolean(a.trackItemId)}>{a.trackItemId ? "In Track ✓" : "Track ↗"}</button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className={styles.card}>
                <div className={styles.cardLab}>Transcript</div>
                {detail.transcript.length ? detail.transcript.map((l, i) => (
                  <div key={i} className={styles.trLine}><span className={styles.trTs}>{l.at}</span><span className={styles.trSp}>{l.speaker}</span><span className={styles.trTx}>{l.text}</span></div>
                )) : <div className={styles.empty}>No transcript.</div>}
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
              placeholder="Paste the transcript. Lines like '[00:12] Anh: …' are parsed into speaker turns."
              value={draftTranscript}
              onChange={(e) => setDraftTranscript(e.target.value)}
              rows={10}
              aria-label="Transcript"
            />
            {createErr ? <div className={styles.errorBar} role="alert">{createErr}</div> : null}
            <div className={styles.modalActions} style={{ justifyContent: "space-between" }}>
              <button type="button" className={styles.track} onClick={() => (recording ? stopRecording() : void startRecording())} disabled={busy === "transcribe"}>
                {recording ? "■ Stop recording" : busy === "transcribe" ? "Transcribing…" : "🎙 Record"}
              </button>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className={styles.track} onClick={() => { if (recording) stopRecording(); setCreateOpen(false); }}>Cancel</button>
                <button type="button" className={styles.newBtn} onClick={() => void submitCreate()} disabled={busy === "create" || recording}>
                  {busy === "create" ? "Summarizing…" : "Create + summarize"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
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
