/**
 * ADR-027 D6 (P4-3/P4-4/P4-5) — the agent-callable control layer.
 *
 * Today the human is the only one who can operate the workbench: features are
 * reachable by clicking, and the agent can only ask someone to click. The fix
 * is not to give the agent a mouse — it is to give every workbench feature a
 * NAME, a TYPE, and a declared SIDE EFFECT, so the same action is callable by a
 * person, by the agent, and by a test, through one registry.
 *
 * That registry doubles as the renderer↔main command map (P4-4). One map rather
 * than two matters because two drift: an action added to the UI but not the map
 * is invisible to the agent, and an action in the map with no UI is a promise
 * nothing keeps.
 *
 * Three rules, each present because its absence has a silent failure mode:
 *
 *  1. EVERY ACTION DECLARES ITS EFFECT — read, mutate, or destructive. A caller
 *     that cannot tell reading from deleting cannot gate anything, and the
 *     agent needs to know before it acts, not after.
 *  2. DESTRUCTIVE ACTIONS CANNOT BE INVOKED BLIND. They require a confirmation
 *     token naming the action, so "delete the workspace" can never be the
 *     accidental result of a mistyped or model-hallucinated action name.
 *  3. AN UNKNOWN ACTION IS AN ERROR. Never a silent no-op — an agent told
 *     nothing happened will retry; an agent told nothing happened *quietly*
 *     assumes success and continues on a false premise.
 */

export type EffectClass = 'read' | 'mutate' | 'destructive';

/** A minimal parameter description. Deliberately not a full JSON-Schema. */
export interface ParamSpec {
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description: string;
}

export interface ControlAction<A = Record<string, unknown>, R = unknown> {
  /** Stable dotted id, e.g. `session.rename`. This is the agent-visible name. */
  id: string;
  /** One line, imperative. Shown in menus AND given to the model. */
  title: string;
  effect: EffectClass;
  params: Readonly<Record<string, ParamSpec>>;
  run(args: A): Promise<R> | R;
}

export interface ControlRegistry {
  readonly actions: ReadonlyMap<string, ControlAction>;
}

export class ControlError extends Error {
  constructor(message: string, readonly code:
    | 'unknown_action'
    | 'duplicate_action'
    | 'bad_arguments'
    | 'confirmation_required'
    | 'invalid_definition') {
    super(message);
    this.name = 'ControlError';
  }
}

const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

function validate(action: ControlAction): void {
  if (!ID_PATTERN.test(action.id)) {
    throw new ControlError(
      `Action id "${action.id}" must be dotted lowercase (e.g. "session.rename"). ` +
      'Ids are an agent-facing contract; an inconsistent one is guessed at wrongly.',
      'invalid_definition',
    );
  }
  if (!action.title.trim()) {
    throw new ControlError(
      `Action "${action.id}" needs a title — it is what the model reads to decide ` +
      'whether this is the right action.',
      'invalid_definition',
    );
  }
  for (const [name, spec] of Object.entries(action.params)) {
    if (!spec.description.trim()) {
      throw new ControlError(
        `Parameter "${name}" of "${action.id}" needs a description; an undescribed ` +
        'parameter is one the model fills in by guessing.',
        'invalid_definition',
      );
    }
  }
}

export function createRegistry(actions: readonly ControlAction[] = []): ControlRegistry {
  const map = new Map<string, ControlAction>();
  for (const action of actions) {
    validate(action);
    if (map.has(action.id)) {
      // Two implementations behind one name means the meaning of a UI action
      // depends on registration order — a bug that only appears after a
      // refactor moves a file.
      throw new ControlError(`Duplicate action id "${action.id}".`, 'duplicate_action');
    }
    map.set(action.id, action);
  }
  return { actions: map };
}

export function register(
  registry: ControlRegistry,
  action: ControlAction,
): ControlRegistry {
  return createRegistry([...registry.actions.values(), action]);
}

/** The confirmation token a destructive action requires. */
export function confirmationTokenFor(actionId: string): string {
  return `confirm:${actionId}`;
}

export interface InvokeOptions {
  /** Required for destructive actions. Must equal confirmationTokenFor(id). */
  confirmation?: string;
}

function checkArgs(action: ControlAction, args: Record<string, unknown>): void {
  for (const [name, spec] of Object.entries(action.params)) {
    const value = args[name];
    if (value === undefined || value === null) {
      if (spec.required) {
        throw new ControlError(
          `Action "${action.id}" requires parameter "${name}" (${spec.description}).`,
          'bad_arguments',
        );
      }
      continue;
    }
    if (typeof value !== spec.type) {
      throw new ControlError(
        `Action "${action.id}" parameter "${name}" expects ${spec.type}, received ${typeof value}.`,
        'bad_arguments',
      );
    }
  }
  const unknown = Object.keys(args).filter((k) => !(k in action.params));
  if (unknown.length > 0) {
    // An ignored argument is how a caller believes it constrained an action it
    // did not. Rejecting is louder and cheaper than debugging that later.
    throw new ControlError(
      `Action "${action.id}" received unknown parameter(s): ${unknown.join(', ')}.`,
      'bad_arguments',
    );
  }
}

export async function invoke(
  registry: ControlRegistry,
  id: string,
  args: Record<string, unknown> = {},
  options: InvokeOptions = {},
): Promise<unknown> {
  const action = registry.actions.get(id);
  if (!action) {
    throw new ControlError(
      `Unknown action "${id}". Known actions: ${[...registry.actions.keys()].sort().join(', ') || '(none)'}.`,
      'unknown_action',
    );
  }
  if (action.effect === 'destructive') {
    const expected = confirmationTokenFor(id);
    if (options.confirmation !== expected) {
      throw new ControlError(
        `Action "${id}" is destructive and requires confirmation "${expected}". ` +
        'A destructive action must never be the result of a mistyped or guessed name.',
        'confirmation_required',
      );
    }
  }
  checkArgs(action, args);
  return action.run(args);
}

/**
 * Describe the registry for a model.
 *
 * Destructive actions are included rather than hidden: an agent that cannot see
 * them cannot tell the user they exist, and hiding a capability does not remove
 * it — it just moves the surprise. The confirmation requirement is stated.
 */
export function describeForModel(registry: ControlRegistry): Array<{
  name: string;
  description: string;
  effect: EffectClass;
  parameters: Readonly<Record<string, ParamSpec>>;
  requiresConfirmation: boolean;
}> {
  return [...registry.actions.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((action) => ({
      name: action.id,
      description: action.effect === 'destructive'
        ? `${action.title} (DESTRUCTIVE — requires confirmation "${confirmationTokenFor(action.id)}")`
        : action.title,
      effect: action.effect,
      parameters: action.params,
      requiresConfirmation: action.effect === 'destructive',
    }));
}

/** Actions that only read. Useful for a restricted, read-only agent session. */
export function readOnlyView(registry: ControlRegistry): ControlRegistry {
  return createRegistry([...registry.actions.values()].filter((a) => a.effect === 'read'));
}
