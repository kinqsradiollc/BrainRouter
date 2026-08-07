/**
 * ADR-029 C1 — the CLIENT half of the switchboard: which modes this process can
 * answer for, and which it must admit it cannot.
 *
 * Q5 decides resolution is a backend capability "with client caches in front of
 * it". This is that front. It is not merely an optimisation, because the
 * inverse of Q5 is also true: `code/file/...` resolves against a checkout and
 * `chat/session/...` against a transcript on disk, and the backend has neither.
 * A desktop or CLI process is the ONLY place those two can be answered at all.
 *
 * So the split is by what a process can see, not by what is convenient:
 *
 *   - `notes`, `planner`, `track` — local stores, answered here AND on the
 *     server. Both halves call the owning store's own writer, so the two cannot
 *     disagree about who is allowed to create what.
 *   - `code`, `chat` — local only. The server registry deliberately omits them
 *     and reports `unavailable / no_resolver_here`, which renders as "not
 *     available in this app" rather than as a deletion.
 *   - `meetings` — server only. There is no local meetings store to read; the
 *     desktop is an HTTP proxy. A reference to a meeting resolves here as
 *     `no_resolver_here` for the same honest reason, and the desktop asks the
 *     backend instead.
 *
 * **Q4 is enforced by the type, not by discipline.** `code` is built with
 * `linkableWorkspaceMode`, so it has no `create` to call. A second way to write
 * a file — different validation, different audit trail — is the drift this ADR
 * is organised against, and the registry refuses `create` for it with a reason
 * rather than a missing-method error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspacePath } from '../../agent/fs/workspaceFs.js';
import {
  createBlock as notesCreateBlock,
  getBlock as notesGetBlock,
  listBlocks as notesListBlocks,
  updateBlock as notesUpdateBlock,
  blockContext,
  noteBlockRef,
  type NoteBlockKind,
} from '../../notes/index.js';
import {
  addItem as plannerAddItem, getItem as plannerGetItem, updateItem as plannerUpdateItem,
} from '../../planner/plannerStore.js';
import { createWorkItem, getWorkItem } from '../../track/store/items.js';
import { readTranscriptTail } from '../../session/transcript/sessionStore.js';
import { getSessionStateDir } from '../../storage/store.js';
import {
  creatableWorkspaceMode, formatWorkspaceRef, linkableWorkspaceMode,
  resolvedFound, resolvedGone, resolvedUnavailable,
  WorkspaceReferenceRegistry,
  type WorkspaceCreateOutcome, type WorkspaceModeParticipant, type WorkspaceRef,
  type WorkspaceRefViewer, type WorkspaceResolution,
} from '../references/index.js';

/** What a local process needs in order to answer for its own modes. */
export interface LocalWorkspaceContext {
  /** Track and Code are workspace-scoped; notes and the planner are not. */
  workspaceRoot: string;
  /**
   * The account whose user-scoped stores these are. `undefined` is the
   * one-planner-per-install case the planner already ships with (ADR-028 D9),
   * not a missing value to fill in later.
   */
  userId?: string | undefined;
}

/**
 * The viewer a local surface resolves as.
 *
 * A4 makes identity mandatory, and the registry answers `denied` without one.
 * On a single-user desktop the honest identity is "whoever is at this machine",
 * spelled `local` — the same string `notesFile`/`plannerFile` already fall back
 * to, so the viewer and the store agree about whose records these are.
 */
export function localWorkspaceViewer(ctx: LocalWorkspaceContext): WorkspaceRefViewer {
  return { userId: ctx.userId?.trim() || 'local' };
}

/** An HLC's physical half is wall-clock ms, which is what A3's "(deleted 4 Aug)" needs. */
function stampIso(physical: number | undefined): string | undefined {
  return typeof physical === 'number' && Number.isFinite(physical)
    ? new Date(physical).toISOString()
    : undefined;
}

function goneAt(reason: 'deleted', physical: number | undefined): { reason: 'deleted'; at?: string } {
  const at = stampIso(physical);
  return at ? { reason, at } : { reason };
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}

/* -------------------------------------------------------------------- notes */

function noteLabel(text: string, kind: string): string {
  // A divider or an empty page still has to render as something, and the kind
  // is the only truthful thing left to say about it.
  return firstLine(text) || `(empty ${kind})`;
}

function notesParticipant(ctx: LocalWorkspaceContext): WorkspaceModeParticipant {
  return creatableWorkspaceMode({
    mode: 'notes',
    kinds: ['block'],

    resolve(ref): WorkspaceResolution {
      const block = notesGetBlock(ctx.userId, ref.id);
      if (!block) return resolvedGone(ref, { reason: 'never_existed' });
      if (block.deletedAt) return resolvedGone(ref, goneAt('deleted', block.deletedAt.physical));
      // Q3: the block, the headings above it, and a COUNT of the rest. Never
      // the page — someone's meeting notes run to thousands of words, so
      // "include the page" has no upper bound and would silently consume the
      // context belonging to the task that cited it.
      const context = blockContext(notesListBlocks(ctx.userId), block.id);
      return resolvedFound(ref, {
        label: noteLabel(block.text.value, block.kind.value),
        state: context ?? { block },
      });
    },

    /** One row, no page walk — the cheap read behind an inline chip. */
    describe(ref): WorkspaceResolution {
      const block = notesGetBlock(ctx.userId, ref.id);
      if (!block) return resolvedGone(ref, { reason: 'never_existed' });
      if (block.deletedAt) return resolvedGone(ref, goneAt('deleted', block.deletedAt.physical));
      return resolvedFound(ref, { label: noteLabel(block.text.value, block.kind.value) });
    },

    create(intent): WorkspaceCreateOutcome {
      const fields = intent.fields ?? {};
      const kind = typeof fields.kind === 'string' ? (fields.kind as NoteBlockKind) : 'paragraph';
      const block = notesCreateBlock(
        ctx.userId,
        {
          kind,
          // A2: the reference to whatever asked for this block is written into
          // the block's OWN text, because that is where a reference lives. No
          // second edge is stored on the source, so there is nothing to diverge.
          text: intent.from ? `${intent.title}\n\n${formatWorkspaceRef(intent.from)}` : intent.title,
          parentId: typeof fields.parentId === 'string' ? fields.parentId : null,
        },
        Date.now(),
      );
      return { status: 'created', ref: noteBlockRef(block.id) };
    },
  });
}

/* ------------------------------------------------------------------ planner */

function plannerParticipant(ctx: LocalWorkspaceContext): WorkspaceModeParticipant {
  return creatableWorkspaceMode({
    mode: 'planner',
    kinds: ['item'],

    resolve(ref): WorkspaceResolution {
      const item = plannerGetItem(ctx.userId, ref.id);
      // A planner is personal by construction (ADR-028 D9): there is no row for
      // someone else's item to be denied, so absence is absence.
      if (!item) return resolvedGone(ref, { reason: 'never_existed' });
      if (item.deletedAt) return resolvedGone(ref, goneAt('deleted', item.deletedAt.physical));
      return resolvedFound(ref, {
        label: item.completed?.value ? `✓ ${item.title.value}` : item.title.value,
        state: {
          id: item.id,
          title: item.title.value,
          notes: item.notes?.value ?? null,
          dueDate: item.dueDate?.value ?? null,
          completed: item.completed?.value === true,
        },
      });
    },

    create(intent): WorkspaceCreateOutcome {
      const notes = intent.from ? formatWorkspaceRef(intent.from) : undefined;
      const item = plannerAddItem(
        ctx.userId,
        { title: intent.title, ...(notes ? { notes } : {}) },
        Date.now(),
      );
      return { status: 'created', ref: { mode: 'planner', kind: 'item', id: item.id } };
    },
  });
}

/* -------------------------------------------------------------------- track */

/**
 * The LOCAL, workspace-scoped board.
 *
 * The backend has a second board of the same name whose ids share the `wi_`
 * prefix, so `brainrouter://track/work-item/<id>` does not by itself say which
 * store it means. Here it means this checkout's, because that is the only one
 * this process can read; `getWorkItem` accepts the human key (`BR-114`) as well
 * as the id, so a reference written by a person resolves too.
 */
function trackParticipant(ctx: LocalWorkspaceContext): WorkspaceModeParticipant {
  return creatableWorkspaceMode({
    mode: 'track',
    kinds: ['work-item'],

    resolve(ref): WorkspaceResolution {
      const item = getWorkItem(ctx.workspaceRoot, ref.id);
      if (!item) return resolvedGone(ref, { reason: 'never_existed' });
      return resolvedFound(ref, {
        label: `${item.key} ${item.title}`,
        state: { id: item.id, key: item.key, title: item.title, status: item.status, type: item.type },
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
      });
    },

    create(intent): WorkspaceCreateOutcome {
      const item = createWorkItem(ctx.workspaceRoot, {
        title: intent.title,
        // The referring block's URI goes in the description rather than into a
        // second edge table, so the link survives with the record and A2's
        // one-copy rule holds across modes as well as inside Notes.
        ...(intent.from ? { description: `From ${formatWorkspaceRef(intent.from)}` } : {}),
      });
      return { status: 'created', ref: { mode: 'track', kind: 'work-item', id: item.key } };
    },
  });
}

/* --------------------------------------------------------------------- code */

/**
 * Q4 — linkable, never creatable.
 *
 * Resolution reports that the file EXISTS and how big it is; it does not return
 * the contents. A reference is a pointer, and inlining an arbitrary file into
 * whatever resolved it is the unbounded-context failure Q3 rules out one mode
 * over. The agent already has `read_file` for the bounded case, and it is the
 * one path with the validation and the audit trail.
 */
function codeParticipant(ctx: LocalWorkspaceContext): WorkspaceModeParticipant {
  return linkableWorkspaceMode({
    mode: 'code',
    kinds: ['file'],

    resolve(ref): WorkspaceResolution {
      let resolved: string;
      try {
        resolved = resolveWorkspacePath(ctx.workspaceRoot, ref.id);
      } catch (err) {
        // A path that escapes the workspace is not "deleted" — it is a
        // reference this process must refuse to follow, and saying so is more
        // useful than a tombstone that invites someone to restore it.
        return resolvedUnavailable(ref, 'no_resolver_here', err instanceof Error ? err.message : String(err));
      }
      if (!fs.existsSync(resolved)) return resolvedGone(ref, { reason: 'never_existed' });
      const stat = fs.statSync(resolved);
      const where = ref.fragment ? `${path.basename(ref.id)} ${ref.fragment}` : path.basename(ref.id);
      return resolvedFound(ref, {
        label: `${where} — ${ref.id}`,
        state: { path: ref.id, bytes: stat.size, directory: stat.isDirectory() },
        updatedAt: new Date(stat.mtimeMs).toISOString(),
      });
    },
  });
}

/* --------------------------------------------------------------------- chat */

/**
 * A chat SESSION, and deliberately not a chat turn.
 *
 * A turn has no stable id: transcript entries are unkeyed lines and the server
 * re-mints message ids on every sync, so `chat/turn/<session>/<n>` would resolve
 * by array position and point at a different turn after a rewind. A3 names that
 * the worst outcome available — quietly wrong beats obviously empty is the one
 * trade this ADR refuses. The session key IS stable, so that is what is
 * addressable, and "cite the turn" is served by citing the conversation it is in.
 */
function chatParticipant(ctx: LocalWorkspaceContext): WorkspaceModeParticipant {
  return linkableWorkspaceMode({
    mode: 'chat',
    kinds: ['session'],

    resolve(ref): WorkspaceResolution {
      let dir: string;
      try {
        dir = getSessionStateDir(ctx.workspaceRoot, ref.id);
      } catch (err) {
        return resolvedUnavailable(ref, 'no_resolver_here', err instanceof Error ? err.message : String(err));
      }
      if (!fs.existsSync(path.join(dir, 'transcript.jsonl'))) {
        return resolvedGone(ref, { reason: 'never_existed' });
      }
      // A bounded tail, not the transcript: a conversation is unbounded for
      // exactly the reason a page is, and the label only needs its subject.
      const tail = readTranscriptTail(ctx.workspaceRoot, ref.id, 40);
      const opener = tail.find((entry) => entry.role === 'user' && typeof entry.content === 'string');
      return resolvedFound(ref, {
        label: opener ? firstLine(String(opener.content)) : `conversation ${ref.id}`,
        state: { sessionKey: ref.id, recentEntries: tail.length },
      });
    },
  });
}

/* ----------------------------------------------------------------- registry */

/**
 * The switchboard a local surface and the agent share.
 *
 * Built per context rather than memoised, because the workspace root changes
 * when someone opens another project and a registry holding the old one would
 * resolve `code/file/...` against a checkout nobody is looking at — a wrong
 * answer that looks exactly like a right one.
 */
export function buildLocalWorkspaceRegistry(ctx: LocalWorkspaceContext): WorkspaceReferenceRegistry {
  const registry = new WorkspaceReferenceRegistry();
  registry.register(notesParticipant(ctx));
  registry.register(plannerParticipant(ctx));
  registry.register(trackParticipant(ctx));
  registry.register(codeParticipant(ctx));
  registry.register(chatParticipant(ctx));
  return registry;
}

/* --------------------------------------------------------------------- link */

export type WorkspaceLinkOutcome =
  | { readonly ok: true; readonly from: WorkspaceRef; readonly to: WorkspaceRef; readonly alreadyLinked: boolean }
  | { readonly ok: false; readonly reason: 'source_not_writable' | 'source_not_found'; readonly detail: string };

/**
 * A2, as an operation: write the reference into the REFERRING content.
 *
 * There is no edge table and no second write to the target, so this is the only
 * thing linking does — and "what links here" stays a query over content, which
 * is what makes it impossible for the two ends to disagree.
 *
 * Only the modes whose content is editable prose can be a source. Code is
 * refused rather than silently handled, because writing a URI into a source
 * file is an edit to the repository and belongs on the normal edit path with
 * its validation and its audit trail (Q4's argument, applied to the other
 * verb). Chat is refused because a transcript is what was said.
 */
export function linkWorkspaceRef(
  ctx: LocalWorkspaceContext,
  from: WorkspaceRef,
  to: WorkspaceRef,
  nowMs = Date.now(),
): WorkspaceLinkOutcome {
  const uri = formatWorkspaceRef(to);

  if (from.mode === 'notes' && from.kind === 'block') {
    const block = notesGetBlock(ctx.userId, from.id);
    if (!block || block.deletedAt) {
      return { ok: false, reason: 'source_not_found', detail: `no note block ${from.id}` };
    }
    const text = block.text.value;
    // Idempotent by inspection of the content itself, because the content is
    // the only record. Linking twice from one block is a repeated action, not a
    // second reference, and the count in the backlink index would say otherwise.
    if (text.includes(uri)) return { ok: true, from, to, alreadyLinked: true };
    const result = notesUpdateBlock(ctx.userId, from.id, { text: text ? `${text} ${uri}` : uri }, nowMs);
    if (!result.ok) return { ok: false, reason: 'source_not_found', detail: result.reason };
    return { ok: true, from, to, alreadyLinked: false };
  }

  if (from.mode === 'planner' && from.kind === 'item') {
    const item = plannerGetItem(ctx.userId, from.id);
    if (!item || item.deletedAt) {
      return { ok: false, reason: 'source_not_found', detail: `no planner item ${from.id}` };
    }
    const notes = item.notes?.value ?? '';
    if (notes.includes(uri)) return { ok: true, from, to, alreadyLinked: true };
    plannerUpdateItem(ctx.userId, from.id, { notes: notes ? `${notes}\n${uri}` : uri }, nowMs);
    return { ok: true, from, to, alreadyLinked: false };
  }

  return {
    ok: false,
    reason: 'source_not_writable',
    detail:
      `"${from.mode}/${from.kind}" cannot hold a reference. A link lives in the referring content, ` +
      'and only a note block or a planner item has content this can be written into. To cite ' +
      'something from a source file, edit the file.',
  };
}
