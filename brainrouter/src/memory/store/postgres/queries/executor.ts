/**
 * Query-helper execution surface.
 *
 * `PostgresMemoryStore`'s domain SQL was extracted (byte-identical) into the
 * sibling `queries/*.ts` modules. Each helper is a free function that takes an
 * `Executor` — the small set of low-level primitives the class used to expose as
 * private methods (`rows`/`one`/`run`/`tx`) — plus, where a method reached back
 * into store state or other store methods, a `StoreContext` that threads that
 * state through without changing behaviour.
 */

import type { PoolClient, QueryResultRow } from "pg";

/** The low-level query primitives the store methods used to call as `this.*`. */
export interface Executor {
  /** Run a parameterized query and return the rows. `params` are positional ($1..). */
  rows<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<T[]>;
  /** Run a query and return the first row, or null. */
  one<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<T | null>;
  /** Run a write and return rowCount (mirrors SQLite's `changes`). */
  run(text: string, params?: any[]): Promise<number>;
  /** Execute `fn` inside a single transaction on one pooled client. */
  tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}
