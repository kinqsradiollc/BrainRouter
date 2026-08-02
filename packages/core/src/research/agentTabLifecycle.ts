/**
 * ADR-027 D10 (P7-3) — an explicit lifecycle for agent-opened browser tabs.
 *
 * The agent opens tabs to read pages. Without a stated lifecycle two failures
 * follow, and they pull in opposite directions:
 *
 *  - Tabs accumulate. Every research turn leaves one behind, the window fills
 *    with pages nobody asked for, and memory grows until something is killed.
 *  - Tabs get reaped too eagerly. A tab the HUMAN adopted — took over, scrolled,
 *    typed into — disappears mid-use because a counter said it was the oldest.
 *
 * The rule that resolves both: **the agent may only reap what the agent still
 * owns.** Adoption is one-way and permanent. A human who touches an agent tab
 * takes it, and from that moment it is not the agent's to close — closing a tab
 * someone is reading is not recoverable by reopening it, because their scroll
 * position, form state, and place in the page are gone.
 *
 * Ownership is therefore tracked explicitly rather than inferred from focus or
 * recency, both of which are heuristics that guess wrong exactly when a human
 * is doing something slowly and carefully.
 */

export type TabOwner = 'agent' | 'human';

export interface AgentTab {
  id: string;
  url: string;
  owner: TabOwner;
  /** Monotonic sequence at open time. Not a wall clock — see openTab. */
  openedAt: number;
  /** Monotonic sequence at last agent use. */
  lastUsedAt: number;
  /** True while a read is in progress; a tab mid-read is never reaped. */
  busy: boolean;
}

export interface TabPool {
  tabs: readonly AgentTab[];
  /** Maximum tabs the AGENT may hold. Human-adopted tabs do not count. */
  cap: number;
  /** Monotonic counter; the pool never reads a clock. */
  sequence: number;
}

export interface ReapDecision {
  keep: readonly AgentTab[];
  close: readonly AgentTab[];
  /** Why each closed tab was chosen, for the activity log. */
  reasons: Readonly<Record<string, string>>;
}

export class TabLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TabLifecycleError';
  }
}

export function createPool(cap: number): TabPool {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new TabLifecycleError(`Tab cap must be a positive integer, received ${cap}.`);
  }
  return { tabs: [], cap, sequence: 0 };
}

/**
 * Open a tab, or reuse the agent's existing tab for the same URL.
 *
 * Reuse matters because re-reading a page is common and a fresh tab per read is
 * how the accumulation problem starts. A HUMAN-owned tab on the same URL is
 * never reused — it belongs to them, and navigating it would move the page out
 * from under whoever is reading it.
 */
export function openTab(pool: TabPool, url: string): { pool: TabPool; tab: AgentTab } {
  const sequence = pool.sequence + 1;
  const existing = pool.tabs.find((t) => t.owner === 'agent' && t.url === url);
  if (existing) {
    const tab = { ...existing, lastUsedAt: sequence };
    return {
      pool: { ...pool, sequence, tabs: pool.tabs.map((t) => (t.id === tab.id ? tab : t)) },
      tab,
    };
  }
  const tab: AgentTab = {
    id: `tab-${sequence}`,
    url,
    owner: 'agent',
    openedAt: sequence,
    lastUsedAt: sequence,
    busy: false,
  };
  return { pool: { ...pool, sequence, tabs: [...pool.tabs, tab] }, tab };
}

/** Mark a tab busy/idle. A busy tab is mid-read and never reaped. */
export function setBusy(pool: TabPool, id: string, busy: boolean): TabPool {
  return { ...pool, tabs: pool.tabs.map((t) => (t.id === id ? { ...t, busy } : t)) };
}

/**
 * A human took over this tab. One-way and permanent.
 *
 * There is deliberately no `release`. "The human is finished with it" is not
 * something this module can observe, and guessing wrong closes a page someone
 * is using. An abandoned adopted tab is clutter; a wrongly-reaped one is lost
 * work.
 */
export function adoptByHuman(pool: TabPool, id: string): TabPool {
  const found = pool.tabs.some((t) => t.id === id);
  if (!found) throw new TabLifecycleError(`Cannot adopt unknown tab "${id}".`);
  return { ...pool, tabs: pool.tabs.map((t) => (t.id === id ? { ...t, owner: 'human' } : t)) };
}

/**
 * Decide which tabs to close so the agent is back under its cap.
 *
 * Only agent-owned, non-busy tabs are eligible. Least-recently-used first, so a
 * tab the agent keeps returning to survives while a one-off read does not.
 */
export function reap(pool: TabPool): ReapDecision {
  const eligible = pool.tabs.filter((t) => t.owner === 'agent' && !t.busy);
  const agentHeld = pool.tabs.filter((t) => t.owner === 'agent');
  const excess = agentHeld.length - pool.cap;
  if (excess <= 0) return { keep: pool.tabs, close: [], reasons: {} };

  const byLeastRecent = [...eligible].sort(
    (a, b) => a.lastUsedAt - b.lastUsedAt || a.id.localeCompare(b.id),
  );
  const close = byLeastRecent.slice(0, excess);
  const closing = new Set(close.map((t) => t.id));
  const reasons: Record<string, string> = {};
  for (const t of close) {
    reasons[t.id] = `agent tab over cap (${agentHeld.length}/${pool.cap}), least recently used`;
  }
  return { keep: pool.tabs.filter((t) => !closing.has(t.id)), close, reasons };
}

/** Apply a reap decision. */
export function applyReap(pool: TabPool, decision: ReapDecision): TabPool {
  return { ...pool, tabs: decision.keep };
}

/** Tabs the agent still owns. */
export function agentTabCount(pool: TabPool): number {
  return pool.tabs.filter((t) => t.owner === 'agent').length;
}

/**
 * Close every tab the agent still owns — session teardown.
 *
 * Human-adopted tabs survive deliberately: the session ending says nothing
 * about whether someone is still reading a page they took over.
 */
export function releaseSession(pool: TabPool): ReapDecision {
  const close = pool.tabs.filter((t) => t.owner === 'agent');
  const reasons: Record<string, string> = {};
  for (const t of close) reasons[t.id] = 'session ended; tab was still agent-owned';
  return { keep: pool.tabs.filter((t) => t.owner !== 'agent'), close, reasons };
}
