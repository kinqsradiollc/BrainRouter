import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import "./meetings.css";
import { SharePopover } from "./SharePopover.js";
import {
  SCOPE_LABEL,
  type MeetingDetail,
  type MeetingListItem,
  type MeetingScope,
  type MeetingsOps,
} from "./types.js";

const BADGE_CLASS: Record<MeetingScope, string> = {
  private: "mv-b-private",
  team: "mv-b-team",
  org: "mv-b-org",
  public: "mv-b-public",
};

function ScopeBadge({ scope }: { scope: MeetingScope }): ReactElement {
  return (
    <span className={`mv-badge ${BADGE_CLASS[scope]}`}>
      {scope === "private" ? (
        <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
      ) : null}
      {scope === "org" ? "Org" : SCOPE_LABEL[scope]}
    </span>
  );
}

function initials(handle: string): string {
  const base = handle.replace(/@.*/, "").replace(/[^a-zA-Z ]/g, " ").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? handle[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function MeetingsView({ ops }: { ops: MeetingsOps }): ReactElement {
  const [items, setItems] = useState<MeetingListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [composing, setComposing] = useState(false);
  const [query, setQuery] = useState("");
  const [busyShare, setBusyShare] = useState(false);

  const refreshList = useCallback(async () => {
    const list = await ops.list();
    setItems(list);
    setSelectedId((cur) => cur ?? list[0]?.id ?? null);
  }, [ops]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let live = true;
    setComposing(false);
    void ops.get(selectedId).then((d) => { if (live) setDetail(d); });
    return () => { live = false; };
  }, [ops, selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((m) => m.title.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const setScope = useCallback(async (scope: MeetingScope) => {
    if (!detail) return;
    setBusyShare(true);
    try {
      const share = await ops.setScope(detail.id, scope);
      setDetail((d) => (d ? { ...d, share } : d));
      setItems((list) => list.map((m) => (m.id === detail.id ? { ...m, scope } : m)));
    } finally {
      setBusyShare(false);
    }
  }, [detail, ops]);

  const toggleAction = useCallback(async (actionId: string, done: boolean) => {
    if (!detail) return;
    setDetail((d) => (d ? { ...d, actionItems: d.actionItems.map((a) => (a.id === actionId ? { ...a, done } : a)) } : d));
    await ops.toggleAction(detail.id, actionId, done);
  }, [detail, ops]);

  const sendToTrack = useCallback(async (actionId: string) => {
    if (!detail) return;
    const { trackItemId } = await ops.sendActionToTrack(detail.id, actionId);
    setDetail((d) => (d ? { ...d, actionItems: d.actionItems.map((a) => (a.id === actionId ? { ...a, trackItemId } : a)) } : d));
  }, [detail, ops]);

  return (
    <div className="mv-root">
      <div className="mv-col">
        <div className="mv-col-head">
          <h2>Meetings</h2>
          <button type="button" className="mv-newbtn" onClick={() => { setComposing(true); setSelectedId(null); }}>
            <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>New
          </button>
        </div>
        <div className="mv-search">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search meetings" aria-label="Search meetings" />
        </div>
        <div className="mv-items">
          {filtered.map((m) => (
            <div
              key={m.id}
              className={`mv-item${!composing && m.id === selectedId ? " mv-on" : ""}`}
              onClick={() => setSelectedId(m.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") setSelectedId(m.id); }}
            >
              <div className="mv-item-t">{m.title}</div>
              <div className="mv-item-m">
                <span className="mv-item-d">{m.date}</span>
                <ScopeBadge scope={m.scope} />
              </div>
            </div>
          ))}
          {filtered.length === 0 ? (
            <div className="mv-empty">No meetings yet.<br />Record, import audio, or paste a transcript to start.</div>
          ) : null}
        </div>
      </div>

      {composing ? (
        <NewMeeting
          onCancel={() => { setComposing(false); void refreshList(); }}
          onCreate={async (input) => {
            const { id } = await ops.createFromTranscript(input);
            await refreshList();
            setComposing(false);
            setSelectedId(id);
          }}
        />
      ) : detail ? (
        <div className="mv-detail">
          <div className="mv-dhead">
            <div className="mv-dhead-row">
              <div>
                <h3>{detail.title}</h3>
                <div className="mv-att">
                  <span className="mv-av">
                    {detail.attendees.slice(0, 4).map((a) => <span key={a}>{initials(a)}</span>)}
                  </span>
                  {detail.attendees.join(", ")}
                </div>
              </div>
              <div className="mv-hactions">
                <SharePopover share={detail.share} busy={busyShare} onSetScope={setScope} />
                {detail.model ? (
                  <div className="mv-modelchip" title="Summarization model">
                    <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10" /><path d="M12 6v6l4 2" /></svg>
                    {detail.model.label}{detail.model.effort ? <> · <b>{detail.model.effort}</b></> : null}
                  </div>
                ) : null}
                <button type="button" className="mv-iconbtn" aria-label="More">
                  <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
                </button>
              </div>
            </div>
            <div className="mv-metastrip">
              <span className="mv-chip"><span className="mv-g" />{detail.status[0].toUpperCase() + detail.status.slice(1)}</span>
              <span className="mv-chip"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>{detail.date}</span>
              {detail.durationMin ? <span className="mv-chip"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>{detail.durationMin} min</span> : null}
              {detail.wordCount ? <span className="mv-chip"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" /></svg>{detail.wordCount.toLocaleString()} words</span> : null}
            </div>
          </div>

          <div className="mv-dbody">
            <div className="mv-colL">
              <div className="mv-card">
                <div className="mv-card-lab">
                  <span className="mv-lt"><svg className="mv-li" viewBox="0 0 24 24"><path d="M4 4h16v4H4zM4 12h10M4 17h16" /></svg>Summary</span>
                  <div className="mv-cardacts">
                    <button type="button" className="mv-ghost" onClick={() => void ops.regenerateSummary(detail.id)}>
                      <svg viewBox="0 0 24 24"><path d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 0 0-14-3M4 15a8 8 0 0 0 14 3" /></svg>Regenerate
                    </button>
                    <button type="button" className="mv-ghost" onClick={() => void navigator.clipboard?.writeText(detail.summaryMarkdown)}>
                      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>Copy
                    </button>
                  </div>
                </div>
                <SummaryBody markdown={detail.summaryMarkdown} />
              </div>

              {detail.actionItems.length ? (
                <div className="mv-card">
                  <div className="mv-card-lab"><span className="mv-lt"><svg className="mv-li" viewBox="0 0 24 24"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>Action items</span></div>
                  {detail.actionItems.map((a) => (
                    <div className="mv-ai" key={a.id}>
                      <button type="button" className={`mv-cbox${a.done ? " mv-done" : ""}`} aria-label={a.done ? "Mark not done" : "Mark done"} onClick={() => void toggleAction(a.id, !a.done)}>
                        <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
                      </button>
                      <div className="mv-txt">{a.title}{a.assignee ? <div className="mv-who">→ {a.assignee}</div> : null}</div>
                      <button type="button" className={`mv-totrack${a.trackItemId ? " mv-linked" : ""}`} onClick={() => { if (!a.trackItemId) void sendToTrack(a.id); }}>
                        {a.trackItemId ? "In Track ✓" : "Track ↗"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="mv-tpanel">
              <div className="mv-card-lab"><span className="mv-lt"><svg className="mv-li" viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2" /></svg>Transcript</span></div>
              {detail.transcript.map((line, i) => (
                <div className="mv-tr-line" key={i}>
                  <span className="mv-ts">{line.at}</span>
                  <span className="mv-sp">{line.speaker}</span>
                  <span className="mv-tx">{line.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="mv-detail"><div className="mv-empty" style={{ marginTop: 60 }}>Select a meeting, or start a new one.</div></div>
      )}
    </div>
  );
}

function SummaryBody({ markdown }: { markdown: string }): ReactElement {
  // Minimal markdown → the summary is short structured text; render headings, bullets, paragraphs.
  const blocks: ReactElement[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { blocks.push(<ul key={`u${blocks.length}`}>{list.map((li, i) => <li key={i}>{li}</li>)}</ul>); list = []; } };
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith("- ")) { list.push(line.slice(2)); continue; }
    flush();
    if (line.startsWith("### ")) blocks.push(<h4 key={blocks.length}>{line.slice(4)}</h4>);
    else if (line.startsWith("## ")) blocks.push(<h4 key={blocks.length}>{line.slice(3)}</h4>);
    else if (line.startsWith("# ")) blocks.push(<h4 key={blocks.length}>{line.slice(2)}</h4>);
    else blocks.push(<p key={blocks.length}>{line}</p>);
  }
  flush();
  return <>{blocks}</>;
}

function NewMeeting({ onCreate, onCancel }: { onCreate(input: { title: string; transcript: string }): Promise<void>; onCancel(): void }): ReactElement {
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const canSubmit = title.trim().length > 0 && transcript.trim().length > 0 && !busy;
  return (
    <div className="mv-detail">
      <div className="mv-compose">
        <h3>New meeting</h3>
        <p className="mv-hint">Paste a transcript to summarize it now. Recording and audio import arrive with the capture phases.</p>
        <div className="mv-field">
          <label htmlFor="mv-title">Title</label>
          <input id="mv-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly product sync" />
        </div>
        <div className="mv-field">
          <label htmlFor="mv-tr">Transcript</label>
          <textarea id="mv-tr" value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="[00:00] Alice: ..." />
        </div>
        <div>
          <button type="button" className="mv-primary" disabled={!canSubmit} onClick={async () => { setBusy(true); try { await onCreate({ title: title.trim(), transcript }); } finally { setBusy(false); } }}>
            <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>{busy ? "Summarizing…" : "Summarize meeting"}
          </button>
          <button type="button" className="mv-linkbtn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
