import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type { MeetingsOps, TrackItem, TrackStatusCategory } from "./types.js";

/**
 * Meeting Tracks (ADR-018) — the SERVER Track board (`/api/track`, org-scoped),
 * surfaced inside Meetings mode. This is deliberately SEPARATE from the workspace
 * GitHub Track board (`src/track/TrackView.tsx`): meeting action items are tracked
 * to the server and viewable here + on the web dashboard's /track board, never on
 * the GitHub-synced workspace board.
 */

const GROUPS: readonly { key: TrackStatusCategory; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "completed", label: "Done" },
];

const categoryOf = (item: TrackItem): TrackStatusCategory => item.statusCategory ?? "todo";

export function MeetingTracksView({ ops }: { ops: MeetingsOps }): ReactElement {
  const [items, setItems] = useState<TrackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [meetingsOnly, setMeetingsOnly] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await ops.serverTracks();
      setItems(Array.isArray(list) ? list : []);
    } catch {
      setError("Couldn't load tracked items. Check your connection and that you're signed in.");
    } finally {
      setLoading(false);
    }
  }, [ops]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setDone = useCallback(async (item: TrackItem, done: boolean) => {
    const nextCat: TrackStatusCategory = done ? "completed" : "todo";
    setBusy((b) => ({ ...b, [item.id]: true }));
    setItems((list) => list.map((it) => (it.id === item.id ? { ...it, statusCategory: nextCat } : it)));
    try {
      await ops.serverTrackSetDone(item.id, done);
    } catch {
      setError("Couldn't update that item.");
    } finally {
      await refresh();
      setBusy((b) => ({ ...b, [item.id]: false }));
    }
  }, [ops, refresh]);

  const remove = useCallback(async (item: TrackItem) => {
    const ok = globalThis.confirm?.(`Remove "${item.title}" from Track? This untracks it for everyone in your org.`);
    if (ok === false) return;
    setBusy((b) => ({ ...b, [item.id]: true }));
    setItems((list) => list.filter((it) => it.id !== item.id));
    try {
      await ops.serverTrackRemove(item.id);
    } catch {
      setError("Couldn't remove that item.");
      await refresh();
    } finally {
      setBusy((b) => ({ ...b, [item.id]: false }));
    }
  }, [ops, refresh]);

  const visible = useMemo(
    () => (meetingsOnly ? items.filter((i) => i.source === "meeting-action") : items),
    [items, meetingsOnly],
  );
  const fromMeetings = useMemo(() => items.filter((i) => i.source === "meeting-action").length, [items]);

  return (
    <div className="mtk">
      <div className="mtk-head">
        <div className="mtk-head-l">
          <h2 className="mtk-h">Tracked</h2>
          <p className="mtk-sub">Your org's server Track board — including items sent from meetings. Syncs with the web dashboard.</p>
        </div>
        <div className="mtk-actions">
          <button
            type="button"
            className={`mv-ghost${meetingsOnly ? " mtk-active" : ""}`}
            aria-pressed={meetingsOnly}
            onClick={() => setMeetingsOnly((v) => !v)}
          >
            <svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2" /></svg>
            From meetings{fromMeetings ? ` · ${fromMeetings}` : ""}
          </button>
          <button type="button" className="mv-ghost" onClick={() => void refresh()}>
            <svg viewBox="0 0 24 24"><path d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 0 0-14-3M4 15a8 8 0 0 0 14 3" /></svg>
            Refresh
          </button>
        </div>
      </div>

      {error ? <div className="mtk-err">{error}</div> : null}

      <div className="mtk-body">
        {loading ? (
          <div className="mv-empty" style={{ marginTop: 40 }}>Loading tracked items…</div>
        ) : visible.length === 0 ? (
          <div className="mv-empty" style={{ marginTop: 40 }}>
            {meetingsOnly ? "No meeting items tracked yet." : "Nothing tracked yet."}
            <br />Track a meeting action item to see it here.
          </div>
        ) : (
          GROUPS.map((g) => {
            const rows = visible.filter((i) => categoryOf(i) === g.key);
            if (rows.length === 0) return null;
            return (
              <div className="mtk-group" key={g.key}>
                <div className="mtk-glab">{g.label}<span className="mtk-count">{rows.length}</span></div>
                {rows.map((item) => {
                  const done = categoryOf(item) === "completed";
                  return (
                    <div className={`mtk-row${done ? " mtk-doneRow" : ""}`} key={item.id}>
                      <button
                        type="button"
                        className={`mv-cbox${done ? " mv-done" : ""}`}
                        disabled={!!busy[item.id]}
                        aria-label={done ? "Reopen" : "Mark done"}
                        onClick={() => void setDone(item, !done)}
                      >
                        <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
                      </button>
                      <div className="mtk-main">
                        <div className="mtk-title">{item.title}</div>
                        <div className="mtk-meta">
                          {item.source === "meeting-action" ? (
                            <span className="mtk-src">
                              <svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2" /></svg>
                              From meeting
                            </span>
                          ) : null}
                          {item.priority ? <span className="mv-chip">{item.priority}</span> : null}
                          {item.assignee ? <span className="mtk-who">→ {item.assignee}</span> : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="mtk-remove"
                        disabled={!!busy[item.id]}
                        onClick={() => void remove(item)}
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
