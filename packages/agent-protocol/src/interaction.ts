/**
 * Human-interaction protocol.
 *
 * Defines the transport-neutral request/response seam used by terminal and
 * desktop hosts, plus the fail-closed correlator for asynchronous replies.
 */

export type InteractionRequest =
  | { id: string; type: 'confirm'; title: string; detail?: string; dangerous?: boolean; tool?: string }
  | {
      id: string;
      type: 'choice';
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect?: boolean;
    };

export type InteractionResponse =
  | { type: 'confirm'; approved: boolean }
  | { type: 'choice'; labels: string[] }
  | { type: 'dismissed' };

/**
 * What the agent runtime calls when it needs a human decision. The CLI
 * implements this with readline prompts; the Desktop host implements it by
 * emitting `interaction-request` and awaiting the matching
 * `interaction-response` command (see InteractionBroker).
 */
export interface InteractionPort {
  confirm(req: { title: string; detail?: string; dangerous?: boolean; tool?: string }): Promise<boolean>;
  choice(req: {
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }): Promise<string[] | null>;
}

/**
 * Pure request/response correlator for transports where the answer arrives as
 * a separate message. `request()` registers a pending interaction and returns
 * its wire request + promise; `resolve()` settles it. Timeouts settle with
 * `{ type: 'dismissed' }` so the agent's deny-by-default paths fire instead of
 * hanging a turn forever.
 */
export class InteractionBroker {
  private pending = new Map<string, { resolve: (r: InteractionResponse) => void; timer?: ReturnType<typeof setTimeout> }>();
  private counter = 0;

  request(
    req: Omit<Extract<InteractionRequest, { type: 'confirm' }>, 'id'> | Omit<Extract<InteractionRequest, { type: 'choice' }>, 'id'>,
    opts?: { timeoutMs?: number },
  ): { request: InteractionRequest; response: Promise<InteractionResponse> } {
    const id = `ir_${++this.counter}`;
    const request = { ...req, id } as InteractionRequest;
    const response = new Promise<InteractionResponse>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) resolve({ type: 'dismissed' });
        }, opts.timeoutMs);
      }
      this.pending.set(id, { resolve, timer });
    });
    return { request, response };
  }

  /** Settle a pending interaction. Returns false for unknown/already-settled ids. */
  resolve(id: string, response: InteractionResponse): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(response);
    return true;
  }

  /** Settle EVERYTHING as dismissed (host shutdown / turn interrupt). */
  dismissAll(): number {
    let n = 0;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ type: 'dismissed' });
      this.pending.delete(id);
      n += 1;
    }
    return n;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
