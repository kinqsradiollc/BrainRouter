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

/** A background extension result addressed to the session that launched it. */
export interface ExternalSteeringInput extends SteeringInput {
  sessionKey: string;
  label?: string;
}

export interface SessionInputPort {
  publish(text: string, options?: { id?: string; label?: string }): ExternalSteeringInput;
}

type ExternalSteeringListener = (sessionKey: string) => void;

const externalSteeringInbox = new Map<string, ExternalSteeringInput[]>();
const externalSteeringListeners = new Set<ExternalSteeringListener>();
const MAX_EXTERNAL_STEERING_PER_SESSION = 100;

/** Publish a bounded extension result without capturing a CLI/Desktop host. */
export function publishExternalSteering(
  sessionKey: string,
  text: string,
  options: { id?: string; label?: string } = {},
): ExternalSteeringInput {
  const target = sessionKey.trim();
  const normalized = text.trim();
  if (!target) throw new Error('External steering requires a session key.');
  if (!normalized) throw new Error('External steering cannot be empty.');
  if (normalized.length > 20_000) throw new Error('External steering exceeds 20000 characters.');
  const event: ExternalSteeringInput = {
    id: options.id?.trim() || `extension-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    sessionKey: target,
    text: normalized,
    source: 'extension',
    createdAt: Date.now(),
    ...(options.label?.trim() ? { label: options.label.trim().slice(0, 160) } : {}),
  };
  const pending = externalSteeringInbox.get(target);
  if (pending) {
    pending.push(event);
    if (pending.length > MAX_EXTERNAL_STEERING_PER_SESSION) {
      pending.splice(0, pending.length - MAX_EXTERNAL_STEERING_PER_SESSION);
    }
  }
  else externalSteeringInbox.set(target, [event]);
  for (const listener of externalSteeringListeners) {
    try { listener(target); } catch { /* extension delivery must remain fault-isolated */ }
  }
  return { ...event };
}

export function pendingExternalSteeringCount(sessionKey: string): number {
  return externalSteeringInbox.get(sessionKey)?.length ?? 0;
}

export function drainExternalSteering(sessionKey: string): ExternalSteeringInput[] {
  const pending = externalSteeringInbox.get(sessionKey);
  if (!pending?.length) return [];
  externalSteeringInbox.delete(sessionKey);
  return pending.map((event) => ({ ...event }));
}

export function subscribeExternalSteering(listener: ExternalSteeringListener): () => void {
  externalSteeringListeners.add(listener);
  return () => { externalSteeringListeners.delete(listener); };
}

/** Test-only reset for the process-local background delivery channel. */
export function __resetExternalSteering(): void {
  externalSteeringInbox.clear();
  externalSteeringListeners.clear();
}
