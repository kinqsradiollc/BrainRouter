/**
 * ADR-029 C1 — the verbs, and who is allowed to implement how many.
 *
 *   resolve(uri)   -> the current state of the thing, or a tombstone
 *   describe(uri)  -> a one-line label for rendering inline
 *   create(intent) -> make a new thing of this mode's kind
 *   update(intent) -> change one that already exists
 *
 * **`update` is here because Part E made its absence a hole rather than a
 * simplification.** C1 wrote three verbs when a note was a paragraph and the
 * only cross-mode move was "make this a task". Part E gives a page an icon, a
 * title, a cover and a trash; it gives a database a schema and a row a cell. A
 * vocabulary with `create` and no `update` can express every one of those once
 * and none of them again — so a person can rename a page and the agent can only
 * make a second one. That is not a smaller vocabulary, it is one that drifts,
 * which is what C3 exists to prevent.
 *
 * **Creatability is a discriminant, not an optional method.** Q4 decides Code
 * implements `resolve` and `describe` only, and gives a reason that is about
 * design rather than effort: a `create` verb for Code would be a second way to
 * write a file, with different validation and a different audit trail, and the
 * two would drift. If `create` were `create?:` then "Code is not creatable" and
 * "whoever wrote the Code adapter has not got to `create` yet" would be the
 * same value, distinguishable only by asking someone. They are opposite facts —
 * one is a decision to preserve, the other is a gap to close — so they get
 * different types, and `creatableWorkspaceMode` will not compile without the
 * function.
 *
 * `update` sits on the SAME discriminant rather than gaining a third one. Every
 * mode Q4 refuses `create` to is refused `update` for the identical reason — a
 * second writer with different validation — and a mode that owns a record enough
 * to mint one owns it enough to change one. Two discriminants would multiply
 * into four shapes of which two would never be built.
 *
 * **The registry owns every sentence except the label.** A mode returns a
 * `found` label; the wording for denied, gone and unavailable comes from
 * `renderWorkspaceResolution`. Six modes each writing their own "you cannot see
 * this" string is six chances to write the title instead, and A4's leak only
 * has to happen once to have happened.
 *
 * **Nothing here reaches a store directly.** Q2: a cross-mode `create` calls
 * the owning mode's handler — `'planner-add'`, `createTrack`, `createMeeting` —
 * and never its tables. The registry is a switchboard; ownership is preserved
 * because the handler remains the only writer either way.
 */
import { parseWorkspaceRef, type WorkspaceRef } from './ref.js';
import {
  renderWorkspaceResolution,
  resolvedUnavailable,
  type WorkspaceResolution,
} from './resolution.js';

/**
 * Who is asking. A4 makes this mandatory rather than optional: an omitted
 * viewer is how a permission check silently becomes no permission check, and
 * the resulting bug looks like the feature working.
 */
export interface WorkspaceRefViewer {
  readonly userId: string;
  /** D1's partition is `(org_id, user_id, id)`; a personal viewer has no org. */
  readonly orgId?: string | null;
}

export interface WorkspaceModeReader {
  /** The URI authority this participant answers for: `planner`, `notes`, … */
  readonly mode: string;
  /**
   * The kinds it answers for. Declared rather than inferred so a reference to a
   * kind this build does not know reports unavailable-here instead of reaching
   * a resolver that will guess.
   */
  readonly kinds: readonly string[];

  /**
   * The current state, or why there is none. Never `null`, never a throw — the
   * registry converts a throw into `unavailable`, which is a worse answer than
   * the one the mode could have given.
   */
  resolve(ref: WorkspaceRef, viewer: WorkspaceRefViewer): Promise<WorkspaceResolution> | WorkspaceResolution;

  /**
   * A cheaper read for the inline label, when the mode has one — meetings can
   * fetch an overview without the transcript. Optional because it is an
   * optimisation with an identical fallback (`resolve`), which is the one thing
   * that makes an optional method honest: omitting it changes cost, not
   * behaviour.
   */
  describe?(ref: WorkspaceRef, viewer: WorkspaceRefViewer): Promise<WorkspaceResolution> | WorkspaceResolution;
}

/**
 * What one mode tells another to make. Deliberately described rather than
 * typed per mode: the caller is a note that knows a line of text and where it
 * came from, not a client of the planner's schema.
 */
export interface WorkspaceCreateIntent {
  readonly mode: string;
  readonly kind: string;
  /** The human's words — the checklist line, the action item, the chat conclusion. */
  readonly title: string;
  /**
   * The thing asking. A2: the reference is written into the REFERRING content
   * by the caller, so this is context for the new record, never a second stored
   * edge that could disagree with the first.
   */
  readonly from?: WorkspaceRef;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export type WorkspaceCreateRefusal =
  | 'no_such_mode'
  | 'mode_is_not_creatable'
  | 'unsupported_kind'
  | 'denied'
  | 'failed';

/**
 * Q2: `create` is synchronous and returns the new URI, because the caller has
 * to write that reference into its own content and an async create that fails
 * after the note was saved leaves a note claiming a task that does not exist.
 *
 * `pending` is the one named exception — a target that needs a network round
 * trip the owning mode does not control. It still returns a URI immediately;
 * that URI resolves to a `pending` tombstone until it lands.
 */
export type WorkspaceCreateOutcome =
  | {
      readonly status: 'created';
      readonly ref: WorkspaceRef;
      /**
       * ADR-029 E6 — fields the mode has no meaning for, reported rather than
       * dropped. `update` has carried this since it was written; `create` did
       * not, so a caller that asked for a row with three columns and got a row
       * with none was told only that a block had been created. It learns
       * otherwise a long way from here.
       */
      readonly ignored?: readonly string[];
    }
  | { readonly status: 'pending'; readonly ref: WorkspaceRef }
  | { readonly status: 'refused'; readonly reason: WorkspaceCreateRefusal; readonly detail: string };

/**
 * What one mode tells another to CHANGE about a record that already exists.
 *
 * Described the same way `WorkspaceCreateIntent` is, and for the same reason: the
 * caller is a menu item or an agent turn holding a reference and a sentence, not
 * a client of the owning mode's schema. `title` is separated from `fields`
 * because renaming is the change every mode understands, and a caller should not
 * have to know that Notes spells it `text` and the planner spells it `title`.
 */
export interface WorkspaceUpdateIntent {
  readonly ref: WorkspaceRef;
  /** The record's new headline text. Absent means "leave it alone", never "clear it". */
  readonly title?: string;
  /**
   * Mode-specific changes: a todo's `checked`, a page's `icon`, a database row's
   * `props`. A field a mode does not understand is reported in `ignored` rather
   * than dropped — an update that silently did four of five things asked of it
   * is the quietly-wrong outcome A3 rules out, one verb over.
   */
  readonly fields?: Readonly<Record<string, unknown>>;
}

export type WorkspaceUpdateRefusal =
  | 'no_such_mode'
  | 'mode_is_not_writable'
  | 'unsupported_kind'
  | 'not_found'
  | 'denied'
  /** B2's soft lock: another device is holding the block right now. */
  | 'locked'
  | 'nothing_to_change'
  | 'failed';

export type WorkspaceUpdateOutcome =
  | {
      readonly status: 'updated';
      readonly ref: WorkspaceRef;
      /** What actually changed, so a caller can say so rather than assume. */
      readonly changed: readonly string[];
      /** Fields this mode has no meaning for. Never silently discarded. */
      readonly ignored?: readonly string[];
      /** The record's label after the change, for writing back into a document. */
      readonly label?: string;
    }
  | { readonly status: 'refused'; readonly reason: WorkspaceUpdateRefusal; readonly detail: string };

export interface LinkableWorkspaceMode extends WorkspaceModeReader {
  readonly creatable: false;
}

export interface CreatableWorkspaceMode extends WorkspaceModeReader {
  readonly creatable: true;
  create(
    intent: WorkspaceCreateIntent,
    viewer: WorkspaceRefViewer,
  ): Promise<WorkspaceCreateOutcome> | WorkspaceCreateOutcome;
  update(
    intent: WorkspaceUpdateIntent,
    viewer: WorkspaceRefViewer,
  ): Promise<WorkspaceUpdateOutcome> | WorkspaceUpdateOutcome;
}

export type WorkspaceModeParticipant = LinkableWorkspaceMode | CreatableWorkspaceMode;

/** Linkable and not creatable, on purpose. Q4's shape. */
export function linkableWorkspaceMode(def: WorkspaceModeReader): LinkableWorkspaceMode {
  return { ...def, creatable: false };
}

/** Creatable — and neither writer is optional in this argument. */
export function creatableWorkspaceMode(
  def: WorkspaceModeReader & Pick<CreatableWorkspaceMode, 'create' | 'update'>,
): CreatableWorkspaceMode {
  return { ...def, creatable: true };
}

/**
 * The switchboard every surface and the agent share.
 *
 * C3: the agent gets `workspace_resolve` / `workspace_create` / `workspace_link`
 * over this same instance rather than a private path, because a separate agent
 * path drifts from the UI path and the drift shows up as the agent creating
 * things that look subtly wrong in the surface that owns them.
 */
export class WorkspaceReferenceRegistry {
  readonly #participants = new Map<string, WorkspaceModeParticipant>();

  /**
   * Registering twice is a defect, not a re-configuration: the second
   * registration would silently shadow the first, and the symptom is one
   * surface resolving references the other cannot.
   */
  register(participant: WorkspaceModeParticipant): void {
    if (this.#participants.has(participant.mode)) {
      throw new Error(`mode "${participant.mode}" is already registered in this workspace reference registry`);
    }
    if (participant.kinds.length === 0) {
      throw new Error(`mode "${participant.mode}" registered no kinds, so no reference could ever reach it`);
    }
    this.#participants.set(participant.mode, participant);
  }

  participant(mode: string): WorkspaceModeParticipant | null {
    return this.#participants.get(mode) ?? null;
  }

  modes(): string[] {
    return [...this.#participants.keys()].sort();
  }

  /** The modes a "make this a …" menu may offer. C1's readable-versus-usable line. */
  creatableModes(): string[] {
    return [...this.#participants.values()].filter((p) => p.creatable).map((p) => p.mode).sort();
  }

  async resolve(ref: WorkspaceRef, viewer: WorkspaceRefViewer): Promise<WorkspaceResolution> {
    return this.#read(ref, viewer, 'resolve');
  }

  /**
   * The cheap read behind an inline chip. Falls back to `resolve` when the mode
   * has no cheaper path, so a caller never has to know which modes optimised.
   */
  async describe(ref: WorkspaceRef, viewer: WorkspaceRefViewer): Promise<WorkspaceResolution> {
    return this.#read(ref, viewer, 'describe');
  }

  /** Resolve a reference that is still a string — parse failures included in the outcome. */
  async resolveUri(uri: string, viewer: WorkspaceRefViewer): Promise<WorkspaceResolution> {
    const parsed = parseWorkspaceRef(uri);
    if (!parsed.ok) return resolvedUnavailable(null, 'malformed_ref', `${parsed.reason}: ${parsed.detail}`);
    return this.resolve(parsed.ref, viewer);
  }

  /** The single line a surface renders. Every non-`found` sentence comes from one place. */
  async describeLine(
    ref: WorkspaceRef,
    viewer: WorkspaceRefViewer,
    opts: { nowMs?: number } = {},
  ): Promise<string> {
    return renderWorkspaceResolution(await this.describe(ref, viewer), opts);
  }

  async create(
    intent: WorkspaceCreateIntent,
    viewer: WorkspaceRefViewer,
  ): Promise<WorkspaceCreateOutcome> {
    const participant = this.#participants.get(intent.mode);
    if (!participant) {
      return { status: 'refused', reason: 'no_such_mode', detail: `no mode "${intent.mode}" is registered here` };
    }
    if (!participant.creatable) {
      return {
        status: 'refused',
        reason: 'mode_is_not_creatable',
        detail:
          `"${intent.mode}" is linkable but not creatable. Its records are made through its own path, ` +
          'not through a second writer with different validation.',
      };
    }
    if (!participant.kinds.includes(intent.kind)) {
      return {
        status: 'refused',
        reason: 'unsupported_kind',
        detail: `"${intent.mode}" makes ${participant.kinds.join(', ')}, not "${intent.kind}"`,
      };
    }
    if (!isIdentified(viewer)) {
      return { status: 'refused', reason: 'denied', detail: 'creating requires an identified viewer' };
    }
    try {
      return await participant.create(intent, viewer);
    } catch (err) {
      // A throw must not reach the editor as an exception: the caller is about
      // to decide whether to write a reference into a document, and it needs an
      // answer it can branch on.
      return { status: 'refused', reason: 'failed', detail: errorText(err) };
    }
  }

  /**
   * Change a record that already exists, through the mode that owns it.
   *
   * The refusals mirror `create`'s deliberately. A mode that is linkable and not
   * creatable is not writable either, and saying "code is linkable but not
   * writable here" is the same sentence Q4 asks `create` to say — a caller that
   * got a generic failure would try again with different arguments forever.
   */
  async update(
    intent: WorkspaceUpdateIntent,
    viewer: WorkspaceRefViewer,
  ): Promise<WorkspaceUpdateOutcome> {
    const participant = this.#participants.get(intent.ref.mode);
    if (!participant) {
      return { status: 'refused', reason: 'no_such_mode', detail: `no mode "${intent.ref.mode}" is registered here` };
    }
    if (!participant.creatable) {
      return {
        status: 'refused',
        reason: 'mode_is_not_writable',
        detail:
          `"${intent.ref.mode}" is linkable but not writable. Its records change through its own path, ` +
          'not through a second writer with different validation.',
      };
    }
    if (!participant.kinds.includes(intent.ref.kind)) {
      return {
        status: 'refused',
        reason: 'unsupported_kind',
        detail: `"${intent.ref.mode}" holds ${participant.kinds.join(', ')}, not "${intent.ref.kind}"`,
      };
    }
    if (!isIdentified(viewer)) {
      return { status: 'refused', reason: 'denied', detail: 'changing a record requires an identified viewer' };
    }
    if (intent.title === undefined && Object.keys(intent.fields ?? {}).length === 0) {
      // Refused rather than treated as a no-op: an update that was asked for
      // nothing is a caller that believes it changed something.
      return { status: 'refused', reason: 'nothing_to_change', detail: 'an update needs a title or at least one field' };
    }
    try {
      return await participant.update(intent, viewer);
    } catch (err) {
      return { status: 'refused', reason: 'failed', detail: errorText(err) };
    }
  }

  async #read(
    ref: WorkspaceRef,
    viewer: WorkspaceRefViewer,
    verb: 'resolve' | 'describe',
  ): Promise<WorkspaceResolution> {
    const participant = this.#participants.get(ref.mode);
    if (!participant) {
      // NOT `gone`. Q5: this client may simply be the wrong one to ask — the
      // dashboard has no local workspace, so every code reference lands here.
      return resolvedUnavailable(ref, 'no_resolver_here', `no mode "${ref.mode}" is registered in this client`);
    }
    if (!participant.kinds.includes(ref.kind)) {
      return resolvedUnavailable(ref, 'no_resolver_here', `"${ref.mode}" does not answer for kind "${ref.kind}"`);
    }
    // A4: no identity, no answer. Never `found`, and `denied` rather than an
    // error because to the reader it is the same situation.
    if (!isIdentified(viewer)) return { status: 'denied', ref };

    try {
      const read = verb === 'describe' && participant.describe ? participant.describe : participant.resolve;
      const outcome = await read.call(participant, ref, viewer);
      // A resolver that returns nothing has answered "there is no such thing",
      // which is precisely the claim A3 forbids making by accident.
      if (!outcome || typeof outcome !== 'object' || !('status' in outcome)) {
        return resolvedUnavailable(ref, 'resolver_failed', `"${ref.mode}" returned no resolution`);
      }
      return outcome;
    } catch (err) {
      return resolvedUnavailable(ref, 'resolver_failed', errorText(err));
    }
  }
}

function isIdentified(viewer: WorkspaceRefViewer | null | undefined): boolean {
  return typeof viewer?.userId === 'string' && viewer.userId.trim().length > 0;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
