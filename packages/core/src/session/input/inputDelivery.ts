/**
 * TURN-1 — shared turn-input delivery primitives.
 *
 * Queue is presentation-neutral and FIFO. Steering is held by Agent because it
 * must enter chat history only at a model-safe boundary (never between an
 * assistant tool call and its tool result).
 */

export type InputDeliveryMode = 'queue' | 'steer';

export interface QueuedInput {
  id: number;
  text: string;
  /** Wire/UI correlation id. Optional for the CLI's local-only queue. */
  deliveryId?: string;
  deliveryMode?: InputDeliveryMode;
  deliverySource?: SteeringInput['source'];
}

export class InputQueue {
  private items: QueuedInput[] = [];
  private nextId = 1;

  enqueue(
    text: string,
    options: {
      deliveryId?: string;
      deliveryMode?: InputDeliveryMode;
      deliverySource?: SteeringInput['source'];
    } = {},
  ): QueuedInput & { position: number } {
    const item: QueuedInput = {
      id: this.nextId++,
      text,
      ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}),
      ...(options.deliveryMode ? { deliveryMode: options.deliveryMode } : {}),
      ...(options.deliverySource ? { deliverySource: options.deliverySource } : {}),
    };
    this.items.push(item);
    return { ...item, position: this.items.length };
  }

  list(): QueuedInput[] {
    return this.items.map((item) => ({ ...item }));
  }

  get size(): number {
    return this.items.length;
  }

  dequeue(): QueuedInput | undefined {
    return this.items.shift();
  }

  removeAt(position1Based: number): QueuedInput | undefined {
    const index = position1Based - 1;
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return undefined;
    return this.items.splice(index, 1)[0];
  }

  removeById(id: number): QueuedInput | undefined {
    const index = this.items.findIndex((item) => item.id === id);
    return index >= 0 ? this.items.splice(index, 1)[0] : undefined;
  }

  clear(): number {
    const count = this.items.length;
    this.items = [];
    return count;
  }
}

export interface SteeringInput {
  id: string;
  text: string;
  source: 'user' | 'extension';
  createdAt: number;
}
