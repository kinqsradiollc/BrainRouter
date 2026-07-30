import { Agent } from '../../agent/agent.js';

export const runningPromises = new Map<string, Promise<void>>();

export function trackedPromiseFor(id: string): Promise<void> | undefined {
  return runningPromises.get(id);
}

// DESK-6 — live child Agent handles keyed by child id, so a parent Stop can
// cascade requestInterrupt() into in-flight delegated children. Holds the
// agent (not just the Promise) and the parent session that owns it, so the
// cascade is scoped to one session and never touches a sibling chat's children.
export const runningChildAgents = new Map<string, { agent: Agent; parentSessionKey: string }>();

/** DESK-6 — live child agents whose parent is `parentSessionKey` (for interrupt cascade). */
export function childAgentsFor(parentSessionKey: string): Agent[] {
  const out: Agent[] = [];
  for (const { agent, parentSessionKey: p } of runningChildAgents.values()) {
    if (p === parentSessionKey) out.push(agent);
  }
  return out;
}

/** WS6 — register a live agent handle (a child OR a worker) so a parent Stop
 *  cascades into it via childAgentsFor → requestInterrupt. Workers previously
 *  weren't registered, so a Stop left them running. */
export function registerInterruptibleAgent(id: string, agent: Agent, parentSessionKey: string): void {
  runningChildAgents.set(id, { agent, parentSessionKey });
}

/** WS6 — drop a handle once it finishes; it's no longer interruptible. */
export function unregisterInterruptibleAgent(id: string): void {
  runningChildAgents.delete(id);
}
