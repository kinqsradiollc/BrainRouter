import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement } from "react";
import type { MeetingsOps, TrackItem, TrackStatusCategory } from "./types.js";

/** The org-scoped server Track board. It intentionally stays separate from the workspace/GitHub board. */
const GROUPS: readonly { key: TrackStatusCategory; label: string; hint: string }[] = [
  { key: "todo", label: "To do", hint: "Ready to start" },
  { key: "in_progress", label: "In progress", hint: "Actively moving" },
  { key: "completed", label: "Done", hint: "Completed work" },
];

const categoryOf = (item: TrackItem): TrackStatusCategory => item.statusCategory ?? "todo";
const errorText = (caught: unknown, fallback: string) => caught instanceof Error && caught.message ? caught.message : fallback;

export function MeetingTracksView({ ops }: { ops: MeetingsOps }): ReactElement {
  const [items, setItems] = useState<TrackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [source, setSource] = useState<"all" | "meeting-action">("all");
  const [query, setQuery] = useState("");
  const [newTitle, setNewTitle] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await ops.serverTracks();
      setItems(Array.isArray(list) ? list : []);
    } catch (caught) {
      setError(errorText(caught, "Could not load tracked items. Check your connection and sign-in."));
    } finally { setLoading(false); }
  }, [ops]);

  useEffect(() => { void refresh(); }, [refresh]);

  const transition = useCallback(async (item: TrackItem, next: TrackStatusCategory) => {
    if (categoryOf(item) === next || busy[item.id]) return;
    const previous = categoryOf(item);
    setBusy((state) => ({ ...state, [item.id]: true }));
    setItems((list) => list.map((row) => row.id === item.id ? { ...row, statusCategory: next } : row));
    setError("");
    try {
      const updated = await ops.serverTrackTransition(item.id, next);
      setItems((list) => list.map((row) => row.id === item.id ? { ...row, ...updated } : row));
    } catch (caught) {
      setItems((list) => list.map((row) => row.id === item.id ? { ...row, statusCategory: previous } : row));
      setError(errorText(caught, "Could not move that item."));
    } finally { setBusy((state) => ({ ...state, [item.id]: false })); }
  }, [busy, ops]);

  const create = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title || busy.create) return;
    setBusy((state) => ({ ...state, create: true }));
    setError("");
    try {
      const created = await ops.serverTrackCreate({ title, statusCategory: "todo" });
      setItems((list) => [created, ...list]);
      setNewTitle("");
    } catch (caught) {
      setError(errorText(caught, "Could not create that Track item."));
    } finally { setBusy((state) => ({ ...state, create: false })); }
  }, [busy.create, newTitle, ops]);

  const remove = useCallback(async (item: TrackItem) => {
    if (globalThis.confirm?.(`Remove “${item.title}” from the organization Track board?`) === false) return;
    const previous = items;
    setBusy((state) => ({ ...state, [item.id]: true }));
    setItems((list) => list.filter((row) => row.id !== item.id));
    setError("");
    try { await ops.serverTrackRemove(item.id); }
    catch (caught) { setItems(previous); setError(errorText(caught, "Could not remove that item.")); }
    finally { setBusy((state) => ({ ...state, [item.id]: false })); }
  }, [items, ops]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => (source === "all" || item.source === source) && (!needle || `${item.title} ${item.description ?? ""} ${item.assignee ?? ""}`.toLowerCase().includes(needle)));
  }, [items, query, source]);
  const meetingCount = useMemo(() => items.filter((item) => item.source === "meeting-action").length, [items]);

  return (
    <section className="mtk">
      <header className="mtk-head">
        <div><span className="mv-eyebrow">Organization workspace</span><h2>Meeting Track</h2><p>Action items from meetings and manually tracked work, synced with the dashboard.</p></div>
        <button type="button" className="mv-secondary" onClick={() => void refresh()} disabled={loading}>↻ {loading ? "Refreshing…" : "Refresh"}</button>
      </header>
      {error ? <div className="mv-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}
      <div className="mtk-toolbar">
        <form className="mtk-create" onSubmit={(event) => void create(event)}><label className="mv-sr-only" htmlFor="mtk-new">New Track item</label><input id="mtk-new" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Add an organization Track item…" /><button className="mv-primary" disabled={!newTitle.trim() || busy.create}>{busy.create ? "Adding…" : "Add item"}</button></form>
        <div className="mtk-filters">
          <label className="mv-search mv-search-wide"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Track" aria-label="Search Track" />{query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search">×</button> : null}</label>
          <div className="mv-segment" role="group" aria-label="Filter Track source"><button type="button" className={source === "all" ? "mv-on" : ""} aria-pressed={source === "all"} onClick={() => setSource("all")}>All · {items.length}</button><button type="button" className={source === "meeting-action" ? "mv-on" : ""} aria-pressed={source === "meeting-action"} onClick={() => setSource("meeting-action")}>From meetings · {meetingCount}</button></div>
        </div>
      </div>
      <div className="mtk-board" aria-busy={loading}>
        {GROUPS.map((group) => {
          const rows = visible.filter((item) => categoryOf(item) === group.key);
          return (
            <section className={`mtk-column mtk-column-${group.key}`} key={group.key} aria-label={`${group.label}, ${rows.length} items`}>
              <div className="mtk-column-head"><div><h3>{group.label}<span>{rows.length}</span></h3><p>{group.hint}</p></div><span className="mtk-status-dot" /></div>
              <div className="mtk-cards">
                {rows.map((item) => (
                  <article className={`mtk-card${group.key === "completed" ? " mtk-card-done" : ""}`} key={item.id}>
                    <div className="mtk-card-top"><span className={`mtk-source mtk-source-${item.source}`}>{item.source === "meeting-action" ? "Meeting" : "Manual"}</span><button type="button" className="mtk-remove" disabled={busy[item.id]} onClick={() => void remove(item)} aria-label={`Remove ${item.title}`}>×</button></div>
                    <h4>{item.title}</h4>
                    {item.description ? <p>{item.description}</p> : null}
                    <div className="mtk-meta">{item.priority ? <span>{item.priority}</span> : null}{item.assignee ? <span>→ {item.assignee}</span> : null}</div>
                    <label className="mtk-move"><span>Move to</span><select value={group.key} disabled={busy[item.id]} onChange={(event) => void transition(item, event.target.value as TrackStatusCategory)}>{GROUPS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
                  </article>
                ))}
                {!loading && rows.length === 0 ? <div className="mtk-column-empty">{query || source !== "all" ? "No matching items" : `No ${group.label.toLowerCase()} items`}</div> : null}
                {loading && items.length === 0 ? <div className="mtk-column-empty">Loading…</div> : null}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
