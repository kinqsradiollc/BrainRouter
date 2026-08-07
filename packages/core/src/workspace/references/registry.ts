/**
 * ADR-029 C1 — the three verbs, and who is allowed to implement how many.
 *
 *   resolve(uri)   -> the current state of the thing, or a tombstone
 *   describe(uri)  -> a one-line label for rendering inline
 *   create(intent) -> make a new thing of this mode's kind
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
  | { readonly status: 'created'; readonly ref: WorkspaceRef }
  | { readonly status: 'pending'; readonly ref: WorkspaceRef }
  | { readonly status: 'refused'; readonly reason: WorkspaceCreateRefusal; readonly detail: string };

export interface LinkableWorkspaceMode extends WorkspaceModeReader {
  readonly creatable: false;
}

export interface CreatableWorkspaceMode extends WorkspaceModeReader {
  readonly creatable: true;
  create(
    intent: WorkspaceCreateIntent,
    viewer: WorkspaceRefViewer,
  ): Promise<WorkspaceCreateOutcome> | WorkspaceCreateOutcome;
}

export type WorkspaceModeParticipant = LinkableWorkspaceMode | CreatableWorkspaceMode;

/** Linkable and not creatable, on purpose. Q4's shape. */
export function linkableWorkspaceMode(def: WorkspaceModeReader): LinkableWorkspaceMode {
  return { ...def, creatable: false };
}

/** Creatable — and the `create` function is not optional in this argument. */
export function creatableWorkspaceMode(
  def: WorkspaceModeReader & Pick<CreatableWorkspaceMode, 'create'>,
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
