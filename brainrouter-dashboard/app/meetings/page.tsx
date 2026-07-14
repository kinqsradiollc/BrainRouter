"use client";

/**
 * Meetings — the dashboard mirror of the desktop Meetings mode (ADR-018). Lists the
 * account's recallable meeting summaries and shows a detail with the same model +
 * four-level sharing vocabulary (Private / Team / Org / Public). Data comes from
 * `/api/meetings`; an in-memory sample renders until the backend route lands.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import styles from "./meetings.module.css";

type Scope = "private" | "team" | "org" | "public";
interface ListItem { id: string; title: string; date: string; scope: Scope; }
interface ActionItem { id: string; title: string; assignee?: string; trackItemId?: string; }
interface Detail {
  id: string; title: string; date: string; status: string; durationMin?: number; wordCount?: number;
  attendees: string[]; model?: { label: string; effort?: string };
  summary: string; actions: ActionItem[]; transcript: { at: string; sp: string; tx: string }[];
  share: { scope: Scope; publicUrl?: string; expiresAt?: string };
}

const SCOPE_META: Record<Scope, { label: string; blurb: string; badge: string; dot: string; icon: string }> = {
  private: { label: "Private", blurb: "Only you can see this meeting.", badge: styles.bPrivate, dot: "", icon: "🔒" },
  team: { label: "Team", blurb: "Members of your team can recall it.", badge: styles.bTeam, dot: styles.dotTeam, icon: "◑" },
  org: { label: "Organization", blurb: "Everyone in your organization.", badge: styles.bOrg, dot: styles.dotOrg, icon: "▤" },
  public: { label: "Public", blurb: "Anyone with the link — redacted summary only.", badge: styles.bPublic, dot: styles.dotPublic, icon: "◍" },
};
const SCOPES: Scope[] = ["private", "team", "org", "public"];

async function fetchJson<T>(url: string): Promise<T | null> {
  try { const r = await fetch(url, { credentials: "include" }); return r.ok ? (await r.json() as T) : null; } catch { return null; }
}

const SAMPLE_LIST: ListItem[] = [
  { id: "m1", title: "Weekly product sync", date: "Jul 14", scope: "private" },
  { id: "m2", title: "Design review — Meetings UI", date: "Jul 11", scope: "team" },
  { id: "m3", title: "All-hands Q3 kickoff", date: "Jul 08", scope: "org" },
  { id: "m4", title: "Customer call — Northwind", date: "Jul 03", scope: "public" },
];
function sampleDetail(item: ListItem): Detail {
  return {
    id: item.id, title: item.title, date: "2026-07-14", status: "recorded", durationMin: 32, wordCount: 1240,
    attendees: ["anh", "maya", "jordan"], model: { label: "Opus 4.8", effort: "high" },
    summary: "The team confirmed Meetings ships as a 4th desktop mode, memory-native with four-level sharing. Server-default transcription was agreed, with a local Whisper fallback.\n### Decisions\n- Meetings is account-gated; offline capture stays as a fallback.\n- Summaries route through the server-managed BrainRouter provider.",
    actions: [
      { id: "a1", title: "Wire the sharing scope picker into both surfaces", assignee: "maya" },
      { id: "a2", title: "Finalize the STT microservice Dockerfile", assignee: "jordan" },
    ],
    transcript: [
      { at: "00:12", sp: "Anh", tx: "Let's lock the Meetings placement — desktop mode, dashboard page." },
      { at: "00:31", sp: "Maya", tx: "Sharing needs all four scopes, public with a revocable link." },
      { at: "00:58", sp: "Jordan", tx: "Transcription server-side by default, keep the offline path." },
    ],
    share: { scope: item.scope, publicUrl: item.scope === "public" ? "brainrouter.ai/m/9fK2qX" : undefined, expiresAt: item.scope === "public" ? "in 30 days" : undefined },
  };
}

function ScopeBadge({ scope }: { scope: Scope }) {
  const m = SCOPE_META[scope];
  return <span className={`${styles.badge} ${m.badge}`}>{scope === "org" ? "Org" : m.label}</span>;
}

export default function MeetingsPage() {
  const [items, setItems] = useState<ListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      const list = (await fetchJson<ListItem[]>("/api/meetings")) ?? SAMPLE_LIST;
      setItems(list);
      setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    })();
  }, []);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let live = true;
    void (async () => {
      const item = items.find((m) => m.id === selectedId);
      const d = (await fetchJson<Detail>(`/api/meetings/${selectedId}`)) ?? (item ? sampleDetail(item) : null);
      if (live) { setDetail(d); setShareOpen(false); }
    })();
    return () => { live = false; };
  }, [selectedId, items]);

  const setScope = useCallback(async (scope: Scope) => {
    if (!detail) return;
    const share = (await fetchJson<Detail["share"]>(`/api/meetings/${detail.id}/scope?to=${scope}`))
      ?? { scope, publicUrl: scope === "public" ? "brainrouter.ai/m/9fK2qX" : undefined, expiresAt: scope === "public" ? "in 30 days" : undefined };
    setDetail((d) => (d ? { ...d, share } : d));
    setItems((list) => list.map((m) => (m.id === detail.id ? { ...m, scope } : m)));
  }, [detail]);

  const summaryBlocks = useMemo(() => renderSummary(detail?.summary ?? ""), [detail?.summary]);

  return (
    <AuthGuard>
      <PageHeader title="Meetings" description="Recallable meeting summaries across your organization." />
      <div className={styles.wrap}>
        <div className={styles.list}>
          <div className={styles.listHead}>
            <h2>Meetings</h2>
            <button type="button" className={styles.newBtn}>+ New</button>
          </div>
          {items.map((m) => (
            <div key={m.id} className={`${styles.item}${m.id === selectedId ? ` ${styles.itemOn}` : ""}`} onClick={() => setSelectedId(m.id)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") setSelectedId(m.id); }}>
              <div className={styles.itemT}>{m.title}</div>
              <div className={styles.itemM}><span className={styles.itemD}>{m.date}</span><ScopeBadge scope={m.scope} /></div>
            </div>
          ))}
          {items.length === 0 ? <div className={styles.empty}>No meetings yet.</div> : null}
        </div>

        {detail ? (
          <div className={styles.detail}>
            <div className={styles.dHead}>
              <div className={styles.dHeadRow}>
                <div>
                  <h3>{detail.title}</h3>
                  <div className={styles.att}>{detail.attendees.join(", ")}</div>
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
                <span className={styles.chip}><i />{detail.status[0].toUpperCase() + detail.status.slice(1)}</span>
                <span className={styles.chip}>{detail.date}</span>
                {detail.durationMin ? <span className={styles.chip}>{detail.durationMin} min</span> : null}
                {detail.wordCount ? <span className={styles.chip}>{detail.wordCount.toLocaleString()} words</span> : null}
              </div>
            </div>
            <div className={styles.body}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                <div className={styles.card}>
                  <div className={styles.cardLab}>Summary</div>
                  {summaryBlocks}
                </div>
                {detail.actions.length ? (
                  <div className={styles.card}>
                    <div className={styles.cardLab}>Action items</div>
                    {detail.actions.map((a) => (
                      <div key={a.id} className={styles.ai}>
                        <div className={styles.aiTxt}>{a.title}{a.assignee ? <div className={styles.aiWho}>→ {a.assignee}</div> : null}</div>
                        <button type="button" className={styles.track}>{a.trackItemId ? "In Track ✓" : "Track ↗"}</button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className={styles.card}>
                <div className={styles.cardLab}>Transcript</div>
                {detail.transcript.map((l, i) => (
                  <div key={i} className={styles.trLine}><span className={styles.trTs}>{l.at}</span><span className={styles.trSp}>{l.sp}</span><span className={styles.trTx}>{l.tx}</span></div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.detail}><div className={styles.empty}>Select a meeting.</div></div>
        )}
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
