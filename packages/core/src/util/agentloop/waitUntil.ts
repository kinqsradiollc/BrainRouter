/**
 * CC-P11.2 — `wait_until` condition waiter (0.4.15 thread G).
 *
 * Polls a workspace file condition until it holds or the timeout elapses —
 * the "monitor" primitive for coordinating with detached work (a worker
 * writing its summary, a backgrounded build writing a log/artifact) without
 * the model hand-rolling sleep loops. The condition check is a cheap fs read;
 * timeout/poll are clamped so the model can't park a turn for an hour.
 */
import fs from 'node:fs';

export type WaitCondition = 'file_exists' | 'file_contains';

export const WAIT_DEFAULT_TIMEOUT_MS = 60_000;
export const WAIT_MAX_TIMEOUT_MS = 600_000;
export const WAIT_DEFAULT_POLL_MS = 500;
export const WAIT_MIN_POLL_MS = 50;

/** One condition probe. Never throws. */
export function checkWaitCondition(condition: WaitCondition, resolvedPath: string, text?: string): boolean {
  try {
    if (condition === 'file_exists') return fs.existsSync(resolvedPath);
    if (condition === 'file_contains') {
      if (!fs.existsSync(resolvedPath)) return false;
      return fs.readFileSync(resolvedPath, 'utf-8').includes(text ?? '');
    }
  } catch { /* unreadable → not satisfied */ }
  return false;
}

export interface WaitResult {
  satisfied: boolean;
  waitedMs: number;
  checks: number;
}

/** Poll until the condition holds or timeout. Resolves, never rejects. */
export async function waitUntilCondition(input: {
  condition: WaitCondition;
  resolvedPath: string;
  text?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<WaitResult> {
  const timeout = Math.min(Math.max(0, input.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS), WAIT_MAX_TIMEOUT_MS);
  const poll = Math.max(WAIT_MIN_POLL_MS, input.pollMs ?? WAIT_DEFAULT_POLL_MS);
  const start = Date.now();
  let checks = 0;
  for (;;) {
    checks += 1;
    if (checkWaitCondition(input.condition, input.resolvedPath, input.text)) {
      return { satisfied: true, waitedMs: Date.now() - start, checks };
    }
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) {
      return { satisfied: false, waitedMs: elapsed, checks };
    }
    await new Promise((r) => setTimeout(r, Math.min(poll, timeout - elapsed)));
  }
}
