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
 *  - `code` is absent because the backend has no checkout: a file reference
 *    resolves against a workspace, and only a client with one open can read it.
 *    The registry reports `unavailable / no_resolver_here` for those, which is
 *    the honest answer — "not available in this app" rather than "deleted".
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
import { blockContext, noteBlockRef, type NoteBlock } from "@kinqs/brainrouter-core/notes";
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
    if (block.deletedAt) {
      return resolvedGone(ref, { reason: "deleted", ...(stampIso(block.deletedAt.physical) ? { at: stampIso(block.deletedAt.physical)! } : {}) });
    }

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
    if (block.deletedAt) {
      return resolvedGone(ref, { reason: "deleted", ...(stampIso(block.deletedAt.physical) ? { at: stampIso(block.deletedAt.physical)! } : {}) });
    }
    return resolvedFound(ref, { label: noteLabel(block) });
  },

  async create(intent, viewer) {
    const orgId = orgOf(viewer);
    if (!orgId) return { status: "refused", reason: "denied", detail: "notes are created inside an organization" };
    const fields = intent.fields ?? {};
    const block = await notes.createBlock(
      orgId,
      viewer.userId,
      {
        kind: (fields.kind as NoteBlock["kind"]["value"]) ?? "paragraph",
        text: intent.title,
        parentId: typeof fields.parentId === "string" ? fields.parentId : null,
      },
      Date.now(),
    );
    return { status: "created", ref: noteBlockRef(block.id) };
  },
});

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
  registry = next;
  return next;
}
