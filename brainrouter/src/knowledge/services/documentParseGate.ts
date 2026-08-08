/**
 * ADR-030 Q3 + ADR-027 D12 — hosted document parsing is admitted, not merely awaited.
 *
 * On the desktop the parser has one caller and a machine to itself. Hosted it
 * has neither, and one property of the parser makes that dangerous in a way an
 * ordinary async call is not:
 *
 * > **The parse is a SYNCHRONOUS WebAssembly call.** While `processPdf` runs,
 * > nothing else in this process runs — not another tenant's search, not a
 * > health check. There is no yield point inside it and no way to preempt it.
 *
 * So concurrency here is not a throughput knob, it is an admission decision. Ten
 * simultaneous uploads do not parse in parallel; they parse one after another,
 * and the tenth request waits for nine full parses while every unrelated request
 * in the process waits behind them too. D12's rule for the LLM pools applies
 * exactly:
 *
 * > *A cap without a bounded queue only moves the overload: callers pile up
 * > without limit, and each one still eventually gets a slot long after its own
 * > deadline passed.*
 *
 * Two bounds, and the second is the one that makes this multi-tenant:
 *
 *  - **`maxWaiting`** — how many parses may be queued at all. Past it a request
 *    is refused as busy, immediately, which is a 503 the client can retry rather
 *    than a minute of silence ending in a gateway timeout.
 *  - **`maxWaitingPerTenant`** — how many one org may hold. Without it a single
 *    tenant bulk-importing an archive fills the queue and every other tenant's
 *    upload is refused because of work they did not cause. The per-tenant bound
 *    is deliberately much smaller than the global one: a tenant is entitled to a
 *    share of the queue, not to the queue.
 *
 * There is no age-based shedding here, and that is a decision rather than an
 * omission: the seam this gate protects carries its own wall-clock budget
 * (`DOCUMENT_BOUNDS.timeBudgetMs`), so a queued caller's wait is bounded by
 * `maxWaiting × that budget` and is knowable in advance. The LLM pools need
 * aging because their work has no such ceiling.
 */

/** Parses in flight. One, because one is all the process can actually run. */
const MAX_ACTIVE = 1;

/** Queue depth. With a 10 s parse budget the worst wait is bounded and knowable. */
const DEFAULT_MAX_WAITING = 16;

/** One tenant's share of that queue. */
const DEFAULT_MAX_WAITING_PER_TENANT = 4;

export interface DocumentParseGateOptions {
  maxWaiting?: number;
  maxWaitingPerTenant?: number;
}

export type DocumentParseAdmission<T> =
  | { admitted: true; value: T }
  /** Refused before any work started. The caller answers "busy", never "invalid". */
  | { admitted: false; waiting: number };

export class DocumentParseGate {
  readonly #maxWaiting: number;
  readonly #maxPerTenant: number;
  #active = 0;
  #waiting = 0;
  readonly #perTenant = new Map<string, number>();
  /**
   * The tail of the queue. Each admitted caller chains onto whatever was ahead
   * of it and publishes its own completion as the new tail, so the parses run in
   * arrival order without a list of waiters to shed from.
   */
  #tail: Promise<void> = Promise.resolve();

  constructor(options: DocumentParseGateOptions = {}) {
    this.#maxWaiting = Math.max(1, options.maxWaiting ?? DEFAULT_MAX_WAITING);
    this.#maxPerTenant = Math.max(1, options.maxWaitingPerTenant ?? DEFAULT_MAX_WAITING_PER_TENANT);
  }

  /** For a health endpoint or a test: what the gate is holding right now. */
  get depth(): { active: number; waiting: number } {
    return { active: this.#active, waiting: this.#waiting };
  }

  /**
   * Run one parse, or refuse.
   *
   * `tenant` is the org the upload belongs to; a personal account is its own
   * tenant. It is used only as a counter key — nothing about it reaches the
   * parse, and an unknown value costs one map entry that is deleted when the
   * count returns to zero.
   */
  async run<T>(tenant: string, work: () => Promise<T>): Promise<DocumentParseAdmission<T>> {
    const queued = this.#waiting + this.#active;
    const mine = this.#perTenant.get(tenant) ?? 0;
    if (queued >= this.#maxWaiting + MAX_ACTIVE || mine >= this.#maxPerTenant) {
      return { admitted: false, waiting: queued };
    }

    this.#waiting += 1;
    this.#perTenant.set(tenant, mine + 1);

    const ahead = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });

    let activated = false;
    try {
      // A predecessor that threw is not this caller's problem — it has already
      // reported its own failure — but an unhandled rejection here would take
      // the queue down with it.
      await ahead.catch(() => undefined);
      this.#waiting -= 1;
      this.#active += 1;
      activated = true;
      return { admitted: true, value: await work() };
    } finally {
      // Tracked per caller rather than inferred from the counters: a caller that
      // never reached the front must not decrement the slot a different one is
      // holding, and "which counter am I in" is knowable here and only here.
      if (activated) this.#active -= 1;
      else this.#waiting -= 1;
      const remaining = (this.#perTenant.get(tenant) ?? 1) - 1;
      if (remaining > 0) this.#perTenant.set(tenant, remaining);
      else this.#perTenant.delete(tenant);
      release();
    }
  }
}

/**
 * The process-wide gate.
 *
 * One instance, because the thing being protected is one event loop. A gate per
 * service or per request would count correctly and protect nothing.
 */
export const documentParseGate = new DocumentParseGate();
