/**
 * ADR-027 D6 (P4-3) — the agent-callable control layer.
 *
 * Every UI capability registers here as a NAMED, TYPED, INTROSPECTABLE action.
 * The point is stated in the ADR: new workbench features become agent-operable
 * *by construction* rather than through bespoke IPC per feature. Today a
 * feature is reachable by the mouse and, separately and later, by whatever
 * one-off channel someone wired for it — which is why the agent can drive some
 * of the workbench and not the rest.
 *
 * Three properties this registry enforces, each because the alternative fails
 * quietly:
 *
 *   - AN EXPLICIT SIDE-EFFECT CLASS. Not a boolean. "Does this mutate?" is the
 *     wrong granularity — opening a panel, writing a file, and sending an email
 *     are all "side effects" and warrant completely different treatment. An
 *     action that lies about its class by omission is the dangerous case, so
 *     the field is required and there is no default.
 *   - A DESCRIPTION WRITTEN FOR THE CALLER. The registry is what the agent
 *     enumerates; an action described as "handles the thing" is unusable, and
 *     unusable-by-the-agent is indistinguishable from absent.
 *   - REGISTRATION IS TOTAL. A duplicate name is a programming error, not a
 *     last-write-wins race — two features silently sharing a name means one of
 *     them stops working depending on module load order.
 */

/**
 * What invoking an action does to the world.
 *
 * Ordered by escalating consequence, so a caller can compare with `<`.
 */
export const CONTROL_EFFECTS = [
  /** Reads state. Safe to call speculatively, safe to retry. */
  'read',
  /** Changes what is displayed. Reversible by the user, no data written. */
  'view',
  /** Writes durable local state — settings, files, session data. */
  'mutate',
  /** Leaves the machine: network calls, messages, publishes. Never speculative. */
  'external',
] as const;

export type ControlEffect = (typeof CONTROL_EFFECTS)[number];

const EFFECT_RANK: Record<ControlEffect, number> = {
  read: 0, view: 1, mutate: 2, external: 3,
};

/** A JSON-Schema-shaped argument contract. Kept loose; the host validates. */
export type ControlSchema = Record<string, unknown>;

export interface ControlAction {
  /** Stable dotted name, e.g. `panel.open`. This is the agent's handle. */
  name: string;
  /** Written for whoever must decide whether to call it — agent or human. */
  description: string;
  effect: ControlEffect;
  /** Argument contract. Omit only for actions that genuinely take none. */
  parameters?: ControlSchema;
  /**
   * True when the action cannot be undone by calling something else. Drives
   * whether a host asks first, independent of effect class: a reversible
   * `mutate` and an irreversible one deserve different treatment.
   */
  irreversible?: boolean;
}

export class ControlRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlRegistrationError';
  }
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/**
 * Validate one action. Returns the reason it is unusable, or null.
 *
 * Rejection is deliberate rather than best-effort: an action that registers
 * with a useless description or an unknown effect class is worse than one that
 * fails loudly at startup, because it appears in the agent's catalog and
 * misbehaves later.
 */
export function controlActionError(action: ControlAction): string | null {
  if (!NAME_PATTERN.test(action.name)) {
    return `"${action.name}" must be a dotted lowercase name like "panel.open"`;
  }
  if (!(CONTROL_EFFECTS as readonly string[]).includes(action.effect)) {
    return `"${action.name}" declares unknown effect "${action.effect}"`;
  }
  const description = action.description?.trim() ?? '';
  if (description.length < 12) {
    return `"${action.name}" needs a description a caller can act on`;
  }
  if (action.parameters !== undefined
    && (typeof action.parameters !== 'object' || action.parameters === null || Array.isArray(action.parameters))) {
    return `"${action.name}" parameters must be a schema object`;
  }
  return null;
}

/**
 * The one registry the agent enumerates and invokes through.
 */
export class ControlRegistry {
  private readonly actions = new Map<string, ControlAction>();

  /** Register an action. Throws rather than silently replacing or skipping. */
  register(action: ControlAction): void {
    const error = controlActionError(action);
    if (error) throw new ControlRegistrationError(error);
    if (this.actions.has(action.name)) {
      // Last-write-wins would make behaviour depend on module load order, and
      // the loser fails in a way nobody can reproduce.
      throw new ControlRegistrationError(`"${action.name}" is already registered`);
    }
    this.actions.set(action.name, action);
  }

  get(name: string): ControlAction | undefined {
    return this.actions.get(name);
  }

  /**
   * Everything the agent may call, sorted by name so the catalog it sees is
   * stable between runs.
   */
  list(): readonly ControlAction[] {
    return [...this.actions.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Actions at or below a consequence ceiling.
   *
   * A read-only session enumerates `read`, a normal one stops below `external`.
   * Filtering the CATALOG rather than rejecting at call time means the agent
   * never sees an action it cannot use — it does not waste a turn discovering
   * the refusal, and cannot narrate a capability it does not have.
   */
  listUpTo(ceiling: ControlEffect): readonly ControlAction[] {
    const max = EFFECT_RANK[ceiling];
    return this.list().filter((action) => EFFECT_RANK[action.effect] <= max);
  }

  /** Whether `action` is permitted under a ceiling. */
  static permits(ceiling: ControlEffect, action: ControlAction): boolean {
    return EFFECT_RANK[action.effect] <= EFFECT_RANK[ceiling];
  }

  /** Actions needing confirmation: irreversible, or leaving the machine. */
  requiresConfirmation(): readonly ControlAction[] {
    return this.list().filter((action) => action.irreversible === true || action.effect === 'external');
  }
}
