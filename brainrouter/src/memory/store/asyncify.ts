/**
 * asyncify (ADR-007 Phase 2, transitional) — wrap a synchronous store so it
 * satisfies the now-async {@link IMemoryStore}. Every method call is forwarded to
 * the sync target and its result wrapped in a resolved Promise (already-Promise
 * results pass through unchanged). Non-function properties pass through as-is.
 *
 * This lets the async cutover land in two safe steps: Step 1 flips the whole
 * brain to `await` the store while SQLite (synchronous) still backs it — so the
 * existing test suite validates the async plumbing — and Step 2 swaps in the
 * natively-async PostgresMemoryStore and deletes this shim + SQLite.
 */
import type { IMemoryStore } from "@kinqs/brainrouter-types";

/** Wrap a synchronous store instance as an async {@link IMemoryStore}. */
export function asyncify(sync: object): IMemoryStore {
  return new Proxy(sync, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        return result instanceof Promise ? result : Promise.resolve(result);
      };
    },
  }) as unknown as IMemoryStore;
}
