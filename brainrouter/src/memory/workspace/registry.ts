/**
 * ADR-029 Q5 — resolution is a SERVER capability, and this is the server's half.
 *
 * The desktop, the dashboard and the CLI are three processes reading one
 * backend. A note referencing a planner item has to resolve in all three, and
 * the dashboard has no local store to resolve against — so the address space
 * needs an implementation here rather than only in the client that happens to
 * hold the files. Q5 records that discovering this after the desktop half was
 * written would have meant writing resolution twice.
 *
 * **What is registered here is what the backend can actually answer for**, and
 * the omissions are decisions rather than gaps:
 *
 *  - `code` is registered as LINKABLE and answers `unavailable /
 *    no_resolver_here` for every read, because the backend has no checkout: a
 *    file reference resolves against a workspace, and only a client with one
 *    open can read it. That is the honest answer — "not available in this app"
 *    rather than "deleted". It is registered rather than omitted so that the
 *    write verbs give Q4's sentence, "linkable but not creatable", instead of
 *    "no such mode".
 *  - `chat` is absent because a chat TURN has no stable id to address. The
 *    transcript is an append-only file of unkeyed lines and the server re-mints
 *    message ids on every sync, so `brainrouter://chat/turn/<session>/<n>` would
 *    resolve by array position and quietly point at a different turn after a
 *    rewind. A3 calls that the worst outcome available.
 *  - `meetings` answers for `meeting` and NOT for `action`, for the same reason:
 *    an action item's id is `ai-<index>`, re-minted by every summary
 *    regeneration, and the existing code already concedes it by re-linking
 *    action state across regenerations by lowercased title rather than by id.
 *
 * **Nothing here reaches another mode's tables.** Q2: a cross-mode create calls
 * the owning mode's writer — `notes.createBlock`, `planner.createItem`,
 * `track.createTrack` — so ownership is preserved by construction, because the
 * writer remains the only writer either way.
 */
import {
  creatableWorkspaceMode, formatWorkspaceRef, linkableWorkspaceMode, resolvedDenied,
  resolvedFound, resolvedGone, resolvedUnavailable, WorkspaceReferenceRegistry,
  type WorkspaceRef, type WorkspaceRefViewer, type WorkspaceResolution,
} from "@kinqs/brainrouter-core/workspace/references";
import { blockContext, blockTombstone, isLiveBlock, noteBlockRef, type NoteBlock } from "@kinqs/brainrouter-core/notes";
import * as notes from "../notes/backend.js";
import * as planner from "../planner/backend.js";
import * as track from "../track/backend.js";
import * as meetings from "../meetings/backend.js";

/** Every mode here is org-partitioned; a viewer without one cannot be answered. */
function orgOf(viewer: WorkspaceRefViewer): string | null {
  return typeof viewer.orgId === "string" && viewer.orgId.trim() ? viewer.orgId : null;
}

function needsOrg(ref: WorkspaceRef): WorkspaceResolution {
  return resolvedUnavailable(ref, "no_resolver_here", "this reference resolves inside an organization");
}

/** An HLC's physical half is wall-clock milliseconds, which is what A3's "(deleted 4 Aug)" needs. */
function stampIso(physical: number | undefined): string | undefined {
  return typeof physical === "number" && Number.isFinite(physical)
    ? new Date(physical).toISOString()
    : undefined;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim();
}

/* -------------------------------------------------------------------- notes */

/**
 * C5's second sentence — "restoring the target restores the reference".
 *
 * Restore is a newer `restoredAt` that outvotes the tombstone rather than a
 * cleared `deletedAt` (`memory/notes/backend.ts` says so where it writes the
 * field), so testing `deletedAt` for truthiness makes a restored block resolve
 * as gone for ever — un-citable AND un-editable through the workspace verbs.
 * The comparison is `isLiveBlock`; the date still comes from the tombstone in
 * force, which is what `blockTombstone` returns.
 */
function noteTombstoneOf(block: NoteBlock): { reason: "deleted"; at?: string } | null {
  const tombstone = blockTombstone(block);
  if (!tombstone) return null;
  const at = stampIso(tombstone.physical);
  return at ? { reason: "deleted", at } : { reason: "deleted" };
}

function noteLabel(block: NoteBlock): string {
  const text = firstLine(block.text?.value ?? "");
  if (text) return text;
  // A divider or an empty page still has to render as something; the kind is
  // the only truthful thing left to say about it.
  return `(empty ${block.kind?.value ?? "block"})`;
}

const notesParticipant = creatableWorkspaceMode({
  mode: "notes",
  kinds: ["block"],

  /**
   * A4 in full: the three answers are distinguished rather than collapsed.
   *
   * A block owned by someone else in the same org is `denied` when it is
   * private and readable when it has been shared — never "no longer exists",
   * which would tell a person their colleague's note was deleted because they
   * are not allowed to see it.
   */
  async resolve(ref, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return needsOrg(ref);

    let ownerId = viewer.userId;
    let block = await notes.getBlock(orgId, viewer.userId, ref.id);
    if (!block) {
      const owner = await notes.findBlockOwner(orgId, ref.id);
      if (!owner) return resolvedGone(ref, { reason: "never_existed" });
      if (owner.visibility === "private") return resolvedDenied(ref);
      ownerId = owner.userId;
      block = await notes.getBlock(orgId, owner.userId, ref.id);
      if (!block) return resolvedGone(ref, { reason: "never_existed" });
    }
    const tombstone = noteTombstoneOf(block);
    if (tombstone) return resolvedGone(ref, tombstone);

    // Q3: the block, the headings above it, and a COUNT of the rest. Never the
    // page — someone's meeting notes run to thousands of words, so "include the
    // page" has no upper bound and would consume the context belonging to the
    // task that cited it.
    const all = await notes.listAllBlocks(orgId, ownerId);
    const context = blockContext(all, block.id);
    return resolvedFound(ref, {
      label: noteLabel(block),
      state: context ?? { block },
    });
  },

  /**
   * The cheap read behind an inline chip: one row, no page context.
   *
   * Optional in the interface because omitting it must change cost and not
   * behaviour — this returns the same label `resolve` would, without the second
   * query that builds Q3's context.
   */
  async describe(ref, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return needsOrg(ref);
    const block = await notes.getBlock(orgId, viewer.userId, ref.id);
    if (!block) {
      const owner = await notes.findBlockOwner(orgId, ref.id);
      if (!owner) return resolvedGone(ref, { reason: "never_existed" });
      if (owner.visibility === "private") return resolvedDenied(ref);
      const shared = await notes.getBlock(orgId, owner.userId, ref.id);
      if (!shared) return resolvedGone(ref, { reason: "never_existed" });
      return resolvedFound(ref, { label: noteLabel(shared) });
    }
    const tombstone = noteTombstoneOf(block);
    if (tombstone) return resolvedGone(ref, tombstone);
    return resolvedFound(ref, { label: noteLabel(block) });
  },

  /**
   * E6 — a created block arrives AS the thing that was asked for.
   *
   * `kind` and `parentId` alone is the shape this had first, and everything
   * else the caller named — a row's `props`, a page's `icon` or `cover`, a
   * database's `schema` — was dropped without a word. A database row created
   * that way shows up with every column empty, which is the outcome E6 names,
   * and the caller is not even told: there was no `ignored` channel on create.
   * The same `notePatch` the update verb uses decides what is understood.
   */
  async create(intent, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return { status: "refused", reason: "denied", detail: "notes are created inside an organization" };
    const fields = intent.fields ?? {};
    const { patch, ignored } = notePatch({ fields });
    const block = await notes.createBlock(
      orgId,
      viewer.userId,
      {
        kind: (fields.kind as NoteBlock["kind"]["value"]) ?? "paragraph",
        text: intent.title,
        parentId: typeof fields.parentId === "string" ? fields.parentId : null,
        fields: patch,
      },
      Date.now(),
    );
    return {
      status: "created",
      ref: noteBlockRef(block.id),
      ...(ignored.length > 0 ? { ignored } : {}),
    };
  },

  /**
   * ADR-029 C1's fourth verb, server-side.
   *
   * It goes through `pushOperations` rather than a direct write, which is the
   * whole point: an update from the dashboard or from an agent turn on the
   * server is a DEVICE's operation like any other, merged against what the
   * server holds (D11) and fenced by the block lease (B2/Q1). A privileged
   * server-side write that skipped the merge would be the one path where a
   * client that is behind wins by being the server, which is the asymmetry D11
   * exists to refuse.
   */
  async update(intent, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return { status: "refused", reason: "denied", detail: "notes change inside an organization" };
    const block = await notes.getBlock(orgId, viewer.userId, intent.ref.id);
    if (!block || !isLiveBlock(block)) {
      return { status: "refused", reason: "not_found", detail: `no note block ${intent.ref.id}` };
    }

    const { patch, changed, ignored } = notePatch(intent);
    const at = notes.serverClock(Date.now());
    const outcome = await notes.pushOperations(orgId, viewer.userId, [{
      idempotencyKey: `${intent.ref.id}:workspace-update:${at.physical}.${at.logical}`,
      itemId: intent.ref.id,
      kind: "update",
      at,
      payload: patch,
    }]);
    const refusal = outcome.rejected[0];
    if (refusal) return { status: "refused", reason: "failed", detail: refusal.reason };

    // B2's soft lock, reported as itself. A fenced write is kept as a conflict
    // rather than applied, so answering `updated` here tells the caller its
    // sentence landed while the block on screen still says what it said — E6's
    // own named failure, and the reason a caller retries forever against a lock
    // that is doing its job.
    const fenced = outcome.fenced?.find((entry) => entry.itemId === intent.ref.id && entry.reason === "blocked");
    if (fenced) {
      return { status: "refused", reason: "locked", detail: "This block is being edited on another device." };
    }

    const after = await notes.getBlock(orgId, viewer.userId, intent.ref.id);
    return {
      status: "updated",
      ref: intent.ref,
      // What the merge TOOK, not what the patch asked for. A stale stamp or a
      // fencing penalty can leave a field holding its previous value, and a
      // `changed` list built from the request would name it anyway.
      changed: after ? changed.filter((field) => tookField(after, field, patch[field])) : [],
      ...(ignored.length > 0 ? { ignored } : {}),
      ...(after ? { label: noteLabel(after) } : {}),
    };
  },
});

/**
 * Did the stored block actually end up holding what the patch asked for?
 *
 * Every field `notePatch` accepts is a `Stamped<T>` of a primitive except
 * `props`, which is a map merged key by key — so the comparison is per key
 * there, and "the merge took it" means every key the caller named is now the
 * value it named.
 */
function tookField(block: NoteBlock, field: string, asked: unknown): boolean {
  if (field === "props") {
    if (!asked || typeof asked !== "object") return false;
    const props = (block as { props?: Record<string, { value?: unknown }> }).props ?? {};
    return Object.entries(asked as Record<string, unknown>)
      .every(([key, value]) => JSON.stringify(props[key]?.value) === JSON.stringify(value));
  }
  const stamped = (block as unknown as Record<string, { value?: unknown } | undefined>)[field];
  return JSON.stringify(stamped?.value) === JSON.stringify(asked);
}

/**
 * The block fields a caller may name, and the ones it named that mean nothing.
 *
 * Deliberately the same list the desktop's participant accepts, because C3's
 * rule is one vocabulary: a field that worked in the CLI and was silently
 * dropped by the dashboard is the drift the shared verbs exist to prevent.
 * Unknown fields are reported rather than discarded.
 */
function notePatch(intent: { title?: string; fields?: Readonly<Record<string, unknown>> }): {
  patch: Record<string, unknown>;
  changed: string[];
  ignored: string[];
} {
  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  const ignored: string[] = [];
  if (intent.title !== undefined) { patch.text = intent.title; changed.push("text"); }

  for (const [key, value] of Object.entries(intent.fields ?? {})) {
    if (key === "parentId" || key === "kind") continue;
    const kept =
      ((key === "text" || key === "icon" || key === "cover" || key === "language") && typeof value === "string") ||
      ((key === "checked" || key === "collapsed" || key === "favourite") && typeof value === "boolean") ||
      (key === "level" && typeof value === "number") ||
      (key === "props" && !!value && typeof value === "object" && !Array.isArray(value));
    if (kept) { patch[key] = value; changed.push(key); } else ignored.push(key);
  }
  return { patch, changed, ignored };
}

/* ------------------------------------------------------------------ planner */

const plannerParticipant = creatableWorkspaceMode({
  mode: "planner",
  kinds: ["item"],

  async resolve(ref, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return needsOrg(ref);
    const item = await planner.getItem(orgId, viewer.userId, ref.id);
    // A planner is personal by construction (ADR-028 D9): there is no row for
    // another person's item to be denied, so absence is absence.
    if (!item) return resolvedGone(ref, { reason: "never_existed" });
    if (item.deletedAt) {
      return resolvedGone(ref, { reason: "deleted", ...(stampIso(item.deletedAt.physical) ? { at: stampIso(item.deletedAt.physical)! } : {}) });
    }
    return resolvedFound(ref, {
      label: item.completed?.value ? `✓ ${item.title.value}` : item.title.value,
      state: item,
    });
  },

  async create(intent, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return { status: "refused", reason: "denied", detail: "a planner belongs to an organization account" };
    const item = await planner.createItem(orgId, viewer.userId, { title: intent.title }, Date.now());
    return { status: "created", ref: { mode: "planner", kind: "item", id: item.id } };
  },

  /**
   * Through `pushOperations`, for the reason the notes participant gives: an
   * update made here is a device's operation, merged against server state (D11),
   * not a privileged write that wins by being the server.
   */
  async update(intent, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return { status: "refused", reason: "denied", detail: "a planner belongs to an organization account" };
    const item = await planner.getItem(orgId, viewer.userId, intent.ref.id);
    if (!item || item.deletedAt) {
      return { status: "refused", reason: "not_found", detail: `no planner item ${intent.ref.id}` };
    }

    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    const ignored: string[] = [];
    if (intent.title !== undefined) { patch.title = intent.title; changed.push("title"); }
    for (const [key, value] of Object.entries(intent.fields ?? {})) {
      const kept =
        (key === "notes" && typeof value === "string") ||
        (key === "dueDate" && (typeof value === "string" || value === null)) ||
        (key === "priority" && typeof value === "number") ||
        (key === "completed" && typeof value === "boolean");
      if (kept) { patch[key] = value; changed.push(key); } else ignored.push(key);
    }

    const at = planner.serverClock(Date.now());
    const outcome = await planner.pushOperations(orgId, viewer.userId, [{
      idempotencyKey: `${intent.ref.id}:workspace-update:${at.physical}.${at.logical}`,
      itemId: intent.ref.id,
      kind: "update",
      at,
      payload: patch,
    }], new Date().toISOString());
    const refusal = outcome.rejected[0];
    if (refusal) return { status: "refused", reason: "failed", detail: refusal.reason };

    const after = await planner.getItem(orgId, viewer.userId, intent.ref.id);
    return {
      status: "updated",
      ref: intent.ref,
      changed,
      ...(ignored.length > 0 ? { ignored } : {}),
      ...(after ? { label: after.completed?.value ? `✓ ${after.title.value}` : after.title.value } : {}),
    };
  },
});

/* -------------------------------------------------------------------- track */

/**
 * The ORG board, which is the only Track the backend can see.
 *
 * The desktop also has a local, workspace-scoped board of the same name whose
 * ids share the `wi_` prefix. A `brainrouter://track/work-item/<id>` therefore
 * resolves here against the server board and, on a desktop with a workspace
 * open, may resolve against the local one; the two are separate stores and the
 * URI does not currently distinguish them.
 */
const trackParticipant = creatableWorkspaceMode({
  mode: "track",
  kinds: ["work-item"],

  async resolve(ref, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return needsOrg(ref);
    const item = await track.getTrack(orgId, ref.id);
    if (!item) return resolvedGone(ref, { reason: "never_existed" });
    return resolvedFound(ref, {
      label: `${item.status}: ${item.title}`,
      state: item,
      updatedAt: item.updatedAt,
    });
  },

  async create(intent, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return { status: "refused", reason: "denied", detail: "a work item belongs to an organization" };
    const item = await track.createTrack(orgId, viewer.userId, {
      title: intent.title,
      // The referring block's URI is the idempotency key, so turning the same
      // checklist line into a work item twice produces one item rather than two
      // — the property `trackMeetingAction` already relies on for meetings.
      ...(intent.from ? { sourceRef: formatWorkspaceRef(intent.from) } : {}),
    });
    return { status: "created", ref: { mode: "track", kind: "work-item", id: item.id } };
  },

  /**
   * Change a work item through Track's own writer.
   *
   * `status` is what this exists for: C2's "a checklist line becomes a work
   * item" is half a flow if nothing can then move it, and the half that is
   * missing is the half people notice.
   */
  async update(intent, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return { status: "refused", reason: "denied", detail: "a work item belongs to an organization" };
    const existing = await track.getTrack(orgId, intent.ref.id);
    if (!existing) return { status: "refused", reason: "not_found", detail: `no work item ${intent.ref.id}` };

    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    const ignored: string[] = [];
    if (intent.title !== undefined) { patch.title = intent.title; changed.push("title"); }
    for (const [key, value] of Object.entries(intent.fields ?? {})) {
      if ((key === "status" || key === "description" || key === "assignee" || key === "priority")
        && typeof value === "string") {
        patch[key] = value; changed.push(key);
      } else ignored.push(key);
    }

    const updated = await track.updateTrack(orgId, intent.ref.id, patch);
    if (!updated) return { status: "refused", reason: "not_found", detail: `no work item ${intent.ref.id}` };
    return {
      status: "updated",
      ref: intent.ref,
      changed,
      ...(ignored.length > 0 ? { ignored } : {}),
      label: `${updated.status}: ${updated.title}`,
    };
  },
});

/* ----------------------------------------------------------------- meetings */

const meetingsParticipant = linkableWorkspaceMode({
  mode: "meetings",
  // `action` is deliberately not here — see the header. Its id is positional.
  kinds: ["meeting"],

  async resolve(ref, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return needsOrg(ref);
    const overview = await meetings.getMeetingOverview(viewer.userId, orgId, ref.id);
    if (!overview) return resolvedGone(ref, { reason: "never_existed" });
    return resolvedFound(ref, { label: overview.title, state: overview });
  },
});

/* -------------------------------------------------------------------- code */

/**
 * Registered, and deliberately unable to answer — E6's third point.
 *
 * The backend has no checkout, so a file reference cannot be READ here; that
 * has always been reported honestly as `no_resolver_here`, which renders as
 * "not available in this app" rather than as a deletion. What was wrong was the
 * WRITE side: with the mode unregistered, a server-side `create` for a code ref
 * answered `no_such_mode` — "BrainRouter has never heard of code" — instead of
 * Q4's actual sentence, "code is linkable but not creatable". The two lead
 * somewhere completely different for whoever reads the refusal.
 *
 * `linkableWorkspaceMode` makes that a property of the type: there is no
 * `create` to call, so the registry refuses it by construction on both halves.
 */
const codeParticipant = linkableWorkspaceMode({
  mode: "code",
  kinds: ["file", "symbol"],
  resolve(ref) {
    return resolvedUnavailable(
      ref,
      "no_resolver_here",
      "a file reference resolves against a checkout, and the server has none",
    );
  },
});

/* ----------------------------------------------------------------- registry */

let registry: WorkspaceReferenceRegistry | undefined;

/**
 * The backend's switchboard, built once.
 *
 * Memoised because registering a mode twice throws: a second registration would
 * silently shadow the first, and the symptom is one request resolving references
 * another cannot.
 */
export function workspaceRegistry(): WorkspaceReferenceRegistry {
  if (registry) return registry;
  const next = new WorkspaceReferenceRegistry();
  next.register(notesParticipant);
  next.register(plannerParticipant);
  next.register(trackParticipant);
  next.register(meetingsParticipant);
  next.register(codeParticipant);
  registry = next;
  return next;
}
