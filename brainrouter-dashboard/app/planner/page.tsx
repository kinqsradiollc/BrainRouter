"use client";

/**
 * Planner — ADR-028 Part D on the web.
 *
 * The surface that proves the multi-device design, because it is the one with
 * no workspace checked out at all. Reads the user-scoped planner at
 * `/api/planner` with the signed-in account's JWT: the same items the desktop
 * planner mode shows for the same person.
 *
 * **D10 — the dashboard is a device, not a privileged writer.** The obvious
 * implementation writes straight to the server with no stamp, and then a
 * stamped offline desktop edit meets an unstamped server value and the merge is
 * undefined. So this carries its own `deviceId` and stamps every mutation
 * through the same path as every other client. One merge path, exercised by
 * every surface, so the rarely-taken branch is not the one deciding your data.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { InlineLoading } from "../../components/LoadingSpinner";
import { authFetch } from "../../lib/adminApi";
import styles from "./planner.module.css";

interface Stamp { physical: number; logical: number; deviceId: string }
interface Stamped<T> { value: T; at: Stamp }

interface PlannerItem {
  id: string;
  origin: "owned" | "mirrored";
  source?: string;
  title: Stamped<string>;
  notes?: Stamped<string>;
  dueDate?: Stamped<string | null>;
  priority?: Stamped<number>;
  completed?: Stamped<boolean>;
  deletedAt?: Stamp;
  conflicts?: Record<string, { ours: unknown; theirs: unknown; reason: string }>;
}

/**
 * This browser's device id.
 *
 * Persisted in localStorage so a reload is the SAME device rather than a new
 * peer. A device whose id changes each load would make its own past edits look
 * concurrent with its present ones, and every reload would manufacture
 * conflicts out of a single person's sequential work.
 */
function deviceId(): string {
  const KEY = "br-planner-device";
  let id = typeof window === "undefined" ? null : window.localStorage.getItem(KEY);
  if (!id) {
    id = `web-${Math.random().toString(36).slice(2, 10)}`;
    if (typeof window !== "undefined") window.localStorage.setItem(KEY, id);
  }
  return id;
}

/** The clock, advanced locally and never allowed to go backwards (D3). */
let clock: Stamp = { physical: 0, logical: 0, deviceId: "" };
function nextStamp(): Stamp {
  const device = deviceId();
  const wall = Date.now();
  const physical = Math.max(clock.physical, wall);
  const logical = physical === clock.physical ? clock.logical + 1 : 0;
  clock = { physical, logical, deviceId: device };
  return clock;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export default function PlannerPage() {
  return (
    <AuthGuard>
      <Planner />
    </AuthGuard>
  );
}

function Planner() {
  const [items, setItems] = useState<PlannerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const body = await authFetch<{ items: PlannerItem[] }>("/api/planner/items");
      setItems(body.items ?? []);
      setError(null);
    } catch (e) {
      // The last good list stays on screen. Blanking it because one refresh
      // failed loses what the person was reading for a condition that will
      // resolve on its own.
      setError(e instanceof Error ? e.message : "Could not load the planner.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Push one operation, stamped.
   *
   * Goes through `/push` rather than a REST write, so the SERVER merges it
   * against its current state (D11) exactly as it would an operation arriving
   * from a phone that has been offline all afternoon.
   */
  const push = useCallback(async (item: PlannerItem, kind: "create" | "update" | "delete") => {
    const at = nextStamp();
    const body = {
      operations: [{
        idempotencyKey: `${item.id}:${kind}:${at.physical}.${at.logical}.${at.deviceId}`,
        itemId: item.id,
        kind,
        at,
        payload: item,
      }],
    };
    try {
      const outcome = await authFetch<{ rejected?: Array<{ reason: string }> }>(
        "/api/planner/push",
        { method: "POST", body },
      );
      if (outcome.rejected?.length) {
        // Rejections are SHOWN. A silently dropped operation is work the person
        // did that nobody will ever tell them was lost.
        setError(outcome.rejected[0]!.reason);
      }
    } catch {
      setError("The change could not be sent. It has not been saved.");
    } finally {
      await load();
    }
  }, [load]);

  const add = useCallback(async () => {
    const title = draft.trim();
    if (!title) return;
    const at = nextStamp();
    setDraft("");
    await push({
      id: `web_${at.physical.toString(36)}${at.logical}`,
      origin: "owned",
      title: { value: title, at },
    }, "create");
  }, [draft, push]);

  const toggle = useCallback(async (item: PlannerItem) => {
    const at = nextStamp();
    await push({
      ...item,
      completed: { value: !item.completed?.value, at },
    }, "update");
  }, [push]);

  const open = useMemo(
    () => items.filter((i) => !i.deletedAt && !i.completed?.value),
    [items],
  );
  const done = useMemo(
    () => items.filter((i) => !i.deletedAt && i.completed?.value),
    [items],
  );
  const conflicted = useMemo(
    () => items.filter((i) => i.conflicts && Object.keys(i.conflicts).length > 0),
    [items],
  );

  return (
    <div className={styles.page}>
      <PageHeader
        title="Planner"
        description="Your day, across every project. The same planner the desktop app shows."
      />

      {conflicted.length > 0 ? (
        // The only planner state that cannot resolve itself, so the only one
        // that gets a banner.
        <div className={styles.conflict}>
          {conflicted.length} item{conflicted.length === 1 ? "" : "s"} changed in two places.
          Both versions were kept — open the desktop planner to pick which to keep.
        </div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.add}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          placeholder="What do you intend to do?"
          aria-label="New planner item"
        />
        <button type="button" onClick={() => void add()}>Add</button>
      </div>

      {loading ? <InlineLoading /> : (
        <>
          {open.length === 0 && done.length === 0 ? (
            <div className={styles.empty}>
              <strong>Nothing planned</strong>
              <span>
                Add something you intend to do. Items you create here appear in the desktop
                planner, and the other way round.
              </span>
            </div>
          ) : null}

          {open.map((item) => (
            <Row key={item.id} item={item} onToggle={() => void toggle(item)} />
          ))}

          {done.length > 0 ? (
            <>
              <div className={styles.group}>Done</div>
              {done.map((item) => (
                <Row key={item.id} item={item} onToggle={() => void toggle(item)} />
              ))}
            </>
          ) : null}
        </>
      )}

      <p className={styles.note}>
        Changes made here are merged the same way as changes from any other device — including
        one that was offline when you made them.
      </p>
      {/* Kept so the value is not merely decorative: the cursor is what a real
          incremental pull would resume from. */}
      {cursor ? <span hidden data-cursor={cursor} /> : null}
      <CursorKeeper onCursor={setCursor} />
    </div>
  );
}

/** Records the pull cursor without forcing the page to re-render on it. */
function CursorKeeper({ onCursor }: { onCursor: (c: string) => void }) {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await authFetch<{ cursor?: string }>("/api/planner/pull");
        if (!cancelled && body.cursor) onCursor(body.cursor);
      } catch {
        // A missing cursor means the next pull is a full read, which is correct
        // rather than broken.
      }
    })();
    return () => { cancelled = true; };
  }, [onCursor]);
  return null;
}

function Row({ item, onToggle }: { item: PlannerItem; onToggle: () => void }) {
  const due = item.dueDate?.value;
  const overdue = typeof due === "string" && due.slice(0, 10) < today();
  return (
    <div className={styles.row}>
      <input
        type="checkbox"
        checked={item.completed?.value === true}
        onChange={onToggle}
        aria-label={`Complete ${item.title.value}`}
      />
      <span className={styles.title}>{item.title.value}</span>
      {item.source ? (
        // Provenance, always: a mirrored item that looks local invites edits
        // the next refresh would undo.
        <span className={styles.source} title={`Mirrored from ${item.source}`}>{item.source}</span>
      ) : null}
      {due ? (
        // "Carried over" rather than a red overdue badge — the wording D5 asks
        // for, matching the desktop mode.
        <span className={styles.due}>{overdue ? `carried over · ${due.slice(0, 10)}` : due.slice(0, 10)}</span>
      ) : null}
    </div>
  );
}
