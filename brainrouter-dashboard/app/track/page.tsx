"use client";

/**
 * Track — the dashboard mirror of the desktop Track mode (Jira-class work items).
 * A three-column kanban (To do / In progress / Done) over the org-scoped board at
 * :3747 (/api/track) using the signed-in account's JWT — the same items the desktop
 * sees for the same org. Cards created here (POST), moved between columns (transition),
 * and removed (DELETE) stay in sync with desktop. No sample data.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { InlineLoading } from "../../components/LoadingSpinner";
import { authFetch } from "../../lib/adminApi";
import { invalidateDashboardQueries, queryDashboard } from "../../lib/dashboardQuery";
import styles from "./track.module.css";

type StatusCategory = "todo" | "in_progress" | "completed";

interface TrackItem {
  id: string;
  orgId: string;
  userId: string;
  title: string;
  description: string;
  type: string;
  status: string;
  statusCategory: StatusCategory;
  priority: string;
  assignee: string | null;
  labels: string[];
  source: "manual" | "meeting-action";
  sourceRef: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS: { key: StatusCategory; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "completed", label: "Done" },
];
const ORDER: StatusCategory[] = ["todo", "in_progress", "completed"];

// Move-control copy: forward advances a card, back returns it. Ends are disabled.
const FORWARD_LABEL: Record<StatusCategory, string | null> = { todo: "Start", in_progress: "Mark done", completed: null };
const BACK_LABEL: Record<StatusCategory, string | null> = { todo: null, in_progress: "Reopen", completed: "Reopen" };

function priorityClass(priority: string): string {
  const p = priority.toLowerCase();
  if (p.includes("urgent") || p.includes("high") || p.includes("critical")) return styles.prioHigh;
  if (p.includes("low")) return styles.prioLow;
  return styles.prioMed;
}

export default function TrackPage() {
  const [items, setItems] = useState<TrackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [createErr, setCreateErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await queryDashboard("track:list", () => authFetch<{ items: TrackItem[] }>("/api/track"), { ttlMs: 30_000 });
      setItems(r.items ?? []);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the board.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refetch = useCallback(async () => {
    invalidateDashboardQueries("track:");
    await load();
  }, [load]);

  const createItem = useCallback(async () => {
    const title = draftTitle.trim();
    if (!title) { setCreateErr("A title is required."); return; }
    setBusy("create");
    setCreateErr("");
    try {
      await authFetch<{ item: TrackItem }>("/api/track", { method: "POST", body: { title } });
      setDraftTitle("");
      await refetch();
    } catch (caught) {
      setCreateErr(caught instanceof Error ? caught.message : "Could not create the item.");
    } finally {
      setBusy("");
    }
  }, [draftTitle, refetch]);

  const transition = useCallback(async (item: TrackItem, statusCategory: StatusCategory) => {
    setBusy(`move:${item.id}`);
    setError("");
    try {
      await authFetch<{ item: TrackItem }>(`/api/track/${item.id}/transition`, { method: "POST", body: { statusCategory } });
      await refetch();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not move the item.");
    } finally {
      setBusy("");
    }
  }, [refetch]);

  const removeItem = useCallback(async (item: TrackItem) => {
    if (!window.confirm(`Remove "${item.title}" from Track? This can't be undone.`)) return;
    setBusy(`del:${item.id}`);
    setError("");
    try {
      await authFetch<{ ok: boolean }>(`/api/track/${item.id}`, { method: "DELETE" });
      await refetch();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the item.");
    } finally {
      setBusy("");
    }
  }, [refetch]);

  const byColumn = useMemo(() => {
    const groups: Record<StatusCategory, TrackItem[]> = { todo: [], in_progress: [], completed: [] };
    for (const item of items) (groups[item.statusCategory] ?? groups.todo).push(item);
    return groups;
  }, [items]);

  const doneCount = byColumn.completed.length;

  return (
    <AuthGuard>
      <PageHeader title="Track" description="Your organization's board of work items — to do, in progress, and done.">
        <span className={styles.doneSummary}>{doneCount} done · {items.length} total</span>
        <button type="button" className={styles.refreshBtn} onClick={() => void refetch()} disabled={loading || busy !== ""}>Refresh</button>
      </PageHeader>
      <div className={styles.page}>
        {error ? <div className={styles.errorBar} role="alert">{error}</div> : null}

        {loading && items.length === 0 ? (
          <div className={styles.loadWrap}><InlineLoading label="Loading board…" /></div>
        ) : (
          <div className={styles.board}>
            {COLUMNS.map((col) => {
              const colItems = byColumn[col.key];
              return (
                <section key={col.key} className={styles.col} aria-label={col.label}>
                  <div className={styles.colHead}>
                    <h2>{col.label}</h2>
                    <span className={styles.colCount}>{colItems.length}</span>
                  </div>

                  {col.key === "todo" ? (
                    <div className={styles.composer}>
                      <input
                        className={styles.composerInput}
                        placeholder="Add a work item…"
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void createItem(); }}
                        aria-label="New work item title"
                        disabled={busy === "create"}
                      />
                      <button type="button" className={styles.addBtn} onClick={() => void createItem()} disabled={busy === "create" || !draftTitle.trim()}>
                        {busy === "create" ? "Adding…" : "+ Add"}
                      </button>
                    </div>
                  ) : null}
                  {col.key === "todo" && createErr ? <div className={styles.errorBar} role="alert">{createErr}</div> : null}

                  <div className={styles.colBody}>
                    {colItems.length === 0 ? (
                      <div className={styles.empty}>{col.key === "todo" ? "Nothing to do yet." : col.key === "in_progress" ? "Nothing in progress." : "Nothing done yet."}</div>
                    ) : (
                      colItems.map((item) => {
                        const idx = ORDER.indexOf(item.statusCategory);
                        const prev = idx > 0 ? ORDER[idx - 1] : null;
                        const next = idx < ORDER.length - 1 ? ORDER[idx + 1] : null;
                        const moving = busy === `move:${item.id}`;
                        const deleting = busy === `del:${item.id}`;
                        return (
                          <article key={item.id} className={styles.card}>
                            <div className={styles.cardTitle}>{item.title}</div>
                            <div className={styles.cardMeta}>
                              <span className={`${styles.prio} ${priorityClass(item.priority)}`}>{item.priority}</span>
                              {item.assignee ? <span className={styles.assignee}>@{item.assignee}</span> : null}
                              {item.source === "meeting-action" ? <span className={styles.meetingBadge}>from meeting</span> : null}
                            </div>
                            <div className={styles.cardActions}>
                              <div className={styles.moveGroup}>
                                <button
                                  type="button"
                                  className={styles.moveBtn}
                                  onClick={() => prev && void transition(item, prev)}
                                  disabled={!prev || moving || deleting}
                                  aria-label={prev ? `Move back${BACK_LABEL[item.statusCategory] ? ` — ${BACK_LABEL[item.statusCategory]}` : ""}` : "Already in the first column"}
                                  title={BACK_LABEL[item.statusCategory] ?? "Move back"}
                                >←</button>
                                <button
                                  type="button"
                                  className={styles.moveBtn}
                                  onClick={() => next && void transition(item, next)}
                                  disabled={!next || moving || deleting}
                                  aria-label={next ? `Move forward${FORWARD_LABEL[item.statusCategory] ? ` — ${FORWARD_LABEL[item.statusCategory]}` : ""}` : "Already done"}
                                  title={FORWARD_LABEL[item.statusCategory] ?? "Move forward"}
                                >{FORWARD_LABEL[item.statusCategory] === "Mark done" ? "✓ Done" : "→"}</button>
                              </div>
                              <button
                                type="button"
                                className={styles.removeBtn}
                                onClick={() => void removeItem(item)}
                                disabled={moving || deleting}
                                aria-label={`Remove ${item.title}`}
                                title="Remove"
                              >{deleting ? "…" : "×"}</button>
                            </div>
                          </article>
                        );
                      })
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
