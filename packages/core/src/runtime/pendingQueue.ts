import type { RuntimeTurn } from './runtimeTypes.js';

export interface PendingTurnEntry {
  sequence: number;
  turn: RuntimeTurn;
}

export interface PendingEnqueueResult {
  accepted: boolean;
  queued: number;
  dropped: number;
}

export class PendingTurnQueue {
  private readonly maxPerRuntime: number;
  private readonly queues = new Map<string, PendingTurnEntry[]>();
  private nextSequence = 0;

  constructor(maxPerRuntime = 50) {
    this.maxPerRuntime = Math.max(0, Math.floor(maxPerRuntime));
  }

  enqueue(runtimeId: string, turn: RuntimeTurn): PendingEnqueueResult {
    if (this.maxPerRuntime <= 0) return { accepted: false, queued: 0, dropped: 1 };
    const id = runtimeId.trim();
    if (!id) return { accepted: false, queued: 0, dropped: 1 };
    const queue = this.queues.get(id) ?? [];
    if (queue.length >= this.maxPerRuntime) {
      return { accepted: false, queued: queue.length, dropped: 1 };
    }
    queue.push({ sequence: ++this.nextSequence, turn });
    this.queues.set(id, queue);
    return { accepted: true, queued: queue.length, dropped: 0 };
  }

  drain(runtimeId: string): PendingTurnEntry[] {
    const id = runtimeId.trim();
    const queue = this.queues.get(id) ?? [];
    this.queues.delete(id);
    return queue;
  }

  size(runtimeId: string): number {
    return this.queues.get(runtimeId.trim())?.length ?? 0;
  }
}
