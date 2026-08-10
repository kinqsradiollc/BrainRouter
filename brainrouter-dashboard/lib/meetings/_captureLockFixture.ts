/**
 * A `navigator.locks` that a Node runner can have, and that a test can KILL.
 *
 * The two properties this stands in for are the two the real Web Locks API has
 * and a lease does not: an exclusive lock is exclusive across every tab of the
 * ORIGIN, and a lock is released by the BROWSER when the context holding it goes
 * away. So the origin owns the held set and each `FakeLockManager` is one tab's
 * view of it — the same shape as `FakeCaptureBackend` standing for one origin's
 * OPFS with a store per tab over it.
 *
 * `kill()` is the whole point of the fixture. It is not a release: the tab never
 * runs another line, its callback promise stays pending for ever, and the lock is
 * dropped anyway — which is exactly what `kill -9` looks like from the other
 * tab's side, and the only way to write §6's destructive test without a clock in
 * it.
 *
 * The underscore prefix keeps it out of the `*.test.ts` glob.
 */
import type { CaptureLockManager } from "./captureLock";

export class FakeLockOrigin {
  /** Lock name → the tab holding it. The browser's own table, in one Map. */
  readonly held = new Map<string, FakeLockManager>();

  /**
   * Where acquisitions are recorded, as `"lockHeld:<name>"` / `"lockRefused:<name>"`.
   *
   * A caller can pass the storage fixture's own `calls` array, which makes the
   * two fakes one ordered log — the only way to assert the property that matters
   * most at Record: the lock is taken BEFORE the session record exists, and
   * therefore before the microphone can be asked for.
   */
  readonly log: string[];

  constructor(log: string[] = []) {
    this.log = log;
  }

  /** One tab's `navigator.locks`. */
  tab(): FakeLockManager {
    return new FakeLockManager(this);
  }

  /** The names held right now, for a test that wants to look. */
  get names(): readonly string[] {
    return [...this.held.keys()];
  }
}

export class FakeLockManager implements CaptureLockManager {
  readonly #origin: FakeLockOrigin;

  /** True once the browser has torn this context down; it can do nothing more. */
  #dead = false;

  /** A lock service that will not answer — an origin with storage blocked. */
  failQuery = false;

  queries = 0;

  constructor(origin: FakeLockOrigin) {
    this.#origin = origin;
  }

  async request(
    name: string,
    _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<unknown> {
    if (this.#dead) return new Promise<never>(() => {});
    // `ifAvailable`: a held lock refuses immediately with a null grant rather
    // than queueing the caller behind somebody else's meeting.
    if (this.#origin.held.has(name)) {
      this.#origin.log.push(`lockRefused:${name}`);
      return callback(null);
    }
    this.#origin.held.set(name, this);
    this.#origin.log.push(`lockHeld:${name}`);
    try {
      await callback({ name });
    } finally {
      if (this.#origin.held.get(name) === this) this.#origin.held.delete(name);
    }
    return undefined;
  }

  async query(): Promise<{ readonly held?: readonly { readonly name?: string }[] }> {
    this.queries += 1;
    if (this.failQuery) throw new Error("this origin has no lock service");
    return { held: [...this.#origin.held.keys()].map((name) => ({ name })) };
  }

  /**
   * What the browser does when the tab dies: every lock it held is released, and
   * nothing in that tab is given a chance to run.
   */
  kill(): void {
    this.#dead = true;
    for (const [name, holder] of [...this.#origin.held]) {
      if (holder === this) this.#origin.held.delete(name);
    }
  }
}
