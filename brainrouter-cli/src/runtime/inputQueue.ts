/**
 * C2 (0.4.12) — input queue while busy.
 *
 * A prompt typed while a turn is already running used to be dropped with "A
 * previous turn is still running." This is the pure model behind queueing it
 * instead: messages accumulate in order, can be listed / removed mid-turn, and are
 * drained one at a time after each turn settles. Pure + unit-testable; the REPL owns
 * the (impure) enqueue-on-busy + drain-after-turn wiring.
 */

export interface QueuedInput {
  /** Stable, monotonic id for `/queue remove <id>` (independent of position). */
  id: number;
  text: string;
}

export class InputQueue {
  private items: QueuedInput[] = [];
  private nextId = 1;

  /** Append a message; returns the created entry (with its id + queue position). */
  enqueue(text: string): QueuedInput & { position: number } {
    const item: QueuedInput = { id: this.nextId++, text };
    this.items.push(item);
    return { ...item, position: this.items.length };
  }

  /** Snapshot of the queued messages, in order (a copy — callers can't mutate). */
  list(): QueuedInput[] {
    return this.items.map((it) => ({ ...it }));
  }

  get size(): number {
    return this.items.length;
  }

  /** Remove + return the oldest queued message (FIFO), or undefined when empty. */
  dequeue(): QueuedInput | undefined {
    return this.items.shift();
  }

  /** Remove by 1-based position (what `/queue` displays). Returns the removed item. */
  removeAt(position1Based: number): QueuedInput | undefined {
    const idx = position1Based - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.items.length) return undefined;
    return this.items.splice(idx, 1)[0];
  }

  /** Remove by stable id. Returns the removed item, or undefined if not found. */
  removeById(id: number): QueuedInput | undefined {
    const idx = this.items.findIndex((it) => it.id === id);
    return idx >= 0 ? this.items.splice(idx, 1)[0] : undefined;
  }

  /** Drop everything; returns how many were cleared. */
  clear(): number {
    const n = this.items.length;
    this.items = [];
    return n;
  }
}
