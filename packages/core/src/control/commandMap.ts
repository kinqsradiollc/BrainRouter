/**
 * ADR-027 D6 (P4-4) — one typed command map for the renderer↔main boundary.
 *
 * The boundary is currently a set of independently-declared IPC channels: a
 * name agreed by convention on both sides, a payload shaped by whoever wrote it
 * first, and no mechanism that notices when the two drift. The failure is
 * quiet — a renamed channel or a changed payload compiles fine on both sides
 * and fails at runtime in the user's hands.
 *
 * So the map becomes the single source of truth and the handler registry is
 * checked AGAINST it, in two directions that fail differently:
 *
 *   - A command with no handler is a dead call site. The renderer invokes it,
 *     nothing answers, and the failure surfaces far from its cause.
 *   - A handler with no command is dead code that reads as live. Worse than
 *     useless: it makes the boundary look larger than it is, and the next
 *     person wires against a channel nobody calls.
 *
 * Both are compile errors via {@link HandlerMap}'s exhaustive mapped type, and
 * both are also checked at runtime by {@link createDispatcher} — because the
 * renderer is not the only caller, and a name arriving over IPC is untrusted
 * input regardless of what the types say.
 */

/** One command's request/response contract. Phantom-typed; carries no runtime data. */
export interface CommandContract<Request = unknown, Response = unknown> {
  /** Written for whoever must decide whether to call it. */
  description: string;
  /**
   * ADR-027 D6 — commands inherit the control layer's effect classes, so the
   * boundary and the agent-callable registry describe consequence the same way
   * rather than each inventing a vocabulary.
   */
  effect: 'read' | 'view' | 'mutate' | 'external';
  /** Present only to carry types; never read at runtime. */
  readonly __request?: Request;
  readonly __response?: Response;
}

export type CommandMap = Record<string, CommandContract<never, never>>;

/** Declare a command map, preserving literal key and contract types. */
export function defineCommands<const M extends Record<string, CommandContract<any, any>>>(map: M): M {
  return map;
}

type RequestOf<C> = C extends CommandContract<infer R, any> ? R : never;
type ResponseOf<C> = C extends CommandContract<any, infer R> ? R : never;

/**
 * Handlers for a map.
 *
 * The mapped type is EXHAUSTIVE and EXACT: every command needs a handler
 * (missing one is a compile error), and a handler for an unlisted command is
 * also a compile error. That second direction is the one usually missed, and it
 * is what stops dead channels accumulating.
 */
export type HandlerMap<M extends Record<string, CommandContract<any, any>>> = {
  [K in keyof M]: (request: RequestOf<M[K]>) => Promise<ResponseOf<M[K]>> | ResponseOf<M[K]>;
};

export class UnknownCommandError extends Error {
  constructor(public readonly command: string) {
    // The name is echoed because a typo is the common case and guessing at a
    // near-match would be worse — dispatching something the caller did not ask
    // for is a bug that looks like a success.
    super(`Unknown command "${command}".`);
    this.name = 'UnknownCommandError';
  }
}

export class CommandWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandWiringError';
  }
}

export interface Dispatcher<M extends Record<string, CommandContract<any, any>>> {
  /** Invoke a command with a statically-known name. */
  invoke<K extends keyof M & string>(command: K, request: RequestOf<M[K]>): Promise<ResponseOf<M[K]>>;
  /**
   * Invoke a command whose name arrived as a plain string — from IPC, a tool
   * call, or anywhere else outside the type system. Rejects unknown names with
   * {@link UnknownCommandError} rather than reading `undefined` and throwing
   * something unhelpful several frames later.
   */
  invokeUnsafe(command: string, request: unknown): Promise<unknown>;
  /** Contract for a command, or undefined. */
  describe(command: string): CommandContract | undefined;
  /** Every command name, sorted, so introspection is stable between runs. */
  names(): readonly string[];
}

/**
 * Bind a command map to its handlers.
 *
 * The runtime check duplicates what the types already enforce, deliberately.
 * Types do not survive a `JSON.parse`, an `any` at a module boundary, or a
 * handler object assembled dynamically — and this boundary receives names from
 * a renderer process, which is exactly where a compile-time-only guarantee
 * stops being a guarantee.
 */
export function createDispatcher<M extends Record<string, CommandContract<any, any>>>(
  map: M,
  handlers: HandlerMap<M>,
): Dispatcher<M> {
  const commandNames = Object.keys(map);
  const handlerNames = Object.keys(handlers);

  const missing = commandNames.filter((name) => typeof (handlers as Record<string, unknown>)[name] !== 'function');
  if (missing.length > 0) {
    throw new CommandWiringError(`Command(s) declared with no handler: ${missing.sort().join(', ')}`);
  }
  const orphaned = handlerNames.filter((name) => !(name in map));
  if (orphaned.length > 0) {
    // Dead code that reads as live: it makes the boundary look larger than it
    // is, and the next person wires against a channel nobody calls.
    throw new CommandWiringError(`Handler(s) with no declared command: ${orphaned.sort().join(', ')}`);
  }

  const invokeUnsafe = async (command: string, request: unknown): Promise<unknown> => {
    // `in` rather than a truthy lookup: a command named "constructor" or
    // "toString" would otherwise resolve to something off Object.prototype.
    if (!Object.prototype.hasOwnProperty.call(map, command)) throw new UnknownCommandError(command);
    const handler = (handlers as Record<string, (req: unknown) => unknown>)[command]!;
    return handler(request);
  };

  return {
    invoke: (command, request) => invokeUnsafe(command, request) as Promise<any>,
    invokeUnsafe,
    describe: (command) => (Object.prototype.hasOwnProperty.call(map, command) ? map[command] : undefined),
    names: () => [...commandNames].sort(),
  };
}
