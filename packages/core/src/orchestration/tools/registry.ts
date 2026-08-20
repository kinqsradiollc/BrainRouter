export const runningPromises = new Map<string, Promise<void>>();

export function trackedPromiseFor(id: string): Promise<void> | undefined {
  return runningPromises.get(id);
}

/**
 * The one capability the interrupt cascade needs from a live child: the ability
 * to be told to stop. A concrete `Agent` satisfies this (its `requestInterrupt`),
 * and so does an adapter over a non-Agent child — e.g. an EXTERNAL-agent worker
 * whose `requestInterrupt` disposes its CLI process (ADR-041 A41-15). Holding the
 * interface rather than `Agent` is what lets both be interrupted the same way.
 */
export interface InterruptibleChild {
  requestInterrupt(): void;
}

// DESK-6 — live interruptible child handles keyed by child id, so a parent Stop
// can cascade requestInterrupt() into in-flight delegated children. Holds the
// handle (not just the Promise) and the parent session that owns it, so the
// cascade is scoped to one session and never touches a sibling chat's children.
export const runningChildAgents = new Map<string, { agent: InterruptibleChild; parentSessionKey: string }>();

/** DESK-6 — live interruptible children whose parent is `parentSessionKey` (for interrupt cascade). */
export function childAgentsFor(parentSessionKey: string): InterruptibleChild[] {
  const out: InterruptibleChild[] = [];
  for (const { agent, parentSessionKey: p } of runningChildAgents.values()) {
    if (p === parentSessionKey) out.push(agent);
  }
  return out;
}

/** WS6 — register a live interruptible handle (an in-process child/worker Agent OR
 *  an external-agent worker adapter) so a parent Stop cascades into it via
 *  childAgentsFor → requestInterrupt. Workers previously weren't registered, so a
 *  Stop left them running. */
export function registerInterruptibleAgent(id: string, agent: InterruptibleChild, parentSessionKey: string): void {
  runningChildAgents.set(id, { agent, parentSessionKey });
}

/** WS6 — drop a handle once it finishes; it's no longer interruptible. */
export function unregisterInterruptibleAgent(id: string): void {
  runningChildAgents.delete(id);
}
