import type { MemoryEngine } from "../engine.js";

/**
 * REFAC-ENGINE-SPLIT (0.4.17) — the background-sweeper starters, extracted
 * verbatim from MemoryEngine as free functions taking the engine instance
 * (type-only import → no runtime cycle). Each installs an unref'd `setInterval`
 * onto a private timer field, so the engine's private state is reached through a
 * narrow cast. `engine.ts`'s methods are now thin wrappers delegating here. No
 * behavior change.
 */

/** Private sweeper state on the engine, reached via a narrow cast. */
type SweeperState = {
  sweeperTimer?: NodeJS.Timeout;
  activeSessionSweeperTimer?: NodeJS.Timeout;
  sessionInboxSweeperTimer?: NodeJS.Timeout;
  consolidationSweeperTimer?: NodeJS.Timeout;
  consolidationInProgress?: boolean;
  sweepInProgress: boolean;
};

export function startExtractionSweeper(engine: MemoryEngine): void {
  const self = engine as unknown as SweeperState;
  if (process.env.BRAINROUTER_DISABLE_EXTRACTION_SWEEPER === "true") {
    return;
  }

  const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
  // Floor at 30s — a user typo of `100` (intended seconds, actually ms)
  // would otherwise fire the sweeper 10x/second, each tick hammering the
  // LLM backend with extraction calls for the entire backlog. With a
  // local LM Studio that's an instant model-unload + flood of 400s.
  // 30s is a conservative floor that still feels responsive while keeping
  // backend load sane on consumer hardware.
  const MIN_INTERVAL_MS = 30 * 1000;

  const raw = parseInt(process.env.BRAINROUTER_EXTRACTION_SWEEP_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return;
  }
  let intervalMs = raw;
  if (intervalMs < MIN_INTERVAL_MS) {
    console.error(
      `[BrainRouter] BRAINROUTER_EXTRACTION_SWEEP_INTERVAL_MS=${raw} is below the ${MIN_INTERVAL_MS}ms floor ` +
      `(value is in MILLISECONDS, not seconds). Clamping to ${MIN_INTERVAL_MS}ms. ` +
      `Use a value like 60000 (1 min) or 300000 (5 min) for local backends.`,
    );
    intervalMs = MIN_INTERVAL_MS;
  }

  self.sweeperTimer = setInterval(() => {
    if (self.sweepInProgress) {
      // Previous tick still running (likely waiting on the LLM semaphore).
      // Skip this tick instead of stacking a second invocation.
      return;
    }
    self.sweepInProgress = true;
    engine.sweepUnextractedBacklog()
      .catch((err) => {
        console.error(
          "[BrainRouter] Extraction backlog sweeper failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        self.sweepInProgress = false;
      });
  }, intervalMs);
  self.sweeperTimer.unref?.();
}

export function startActiveSessionSweeper(engine: MemoryEngine): void {
  const self = engine as unknown as SweeperState;
  if (process.env.BRAINROUTER_DISABLE_SESSION_SWEEPER === "true") return;

  const DEFAULT_INTERVAL_MS = 60 * 1000; // 1 minute
  const MIN_INTERVAL_MS = 10 * 1000;
  const raw = parseInt(
    process.env.BRAINROUTER_SESSION_SWEEP_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS),
    10,
  );
  if (!Number.isFinite(raw) || raw <= 0) return;
  const intervalMs = Math.max(raw, MIN_INTERVAL_MS);

  const olderThanMs = parseInt(
    process.env.BRAINROUTER_SESSION_SWEEP_MAX_AGE_MS ?? String(5 * 60 * 1000),
    10,
  );

  self.activeSessionSweeperTimer = setInterval(() => {
    void (async () => {
      try {
        const removed = await engine.store.sweepActiveSessions(olderThanMs);
        if (removed > 0) {
          console.error(`[BrainRouter] active_sessions sweeper removed ${removed} stale row(s).`);
        }
      } catch (err) {
        console.error(
          "[BrainRouter] active_sessions sweeper failed:",
          err instanceof Error ? err.message : err,
        );
      }
    })();
  }, intervalMs);
  self.activeSessionSweeperTimer.unref?.();
}

/**
 * ADR-020 D2 — the autonomous consolidation cycle ("the janitor"). On its own
 * cadence it promotes proven memories into the durable tier and archives stale
 * ones (recoverable), so the store tidies itself without an agent asking. OFF by
 * default (opt-in via BRAINROUTER_CONSOLIDATION_INTERVAL_MS) and never in tests,
 * so it adds no surprise workload; the loop is re-entrancy-guarded and unref'd.
 */
export function startConsolidationSweeper(engine: MemoryEngine): void {
  const self = engine as unknown as SweeperState;
  if (process.env.NODE_ENV === "test" || process.env.BRAINROUTER_DISABLE_CONSOLIDATION === "true") return;

  const raw = parseInt(process.env.BRAINROUTER_CONSOLIDATION_INTERVAL_MS ?? "0", 10);
  if (!Number.isFinite(raw) || raw <= 0) return; // opt-in: unset/0 → disabled
  const MIN_INTERVAL_MS = 60 * 1000;
  const intervalMs = Math.max(raw, MIN_INTERVAL_MS);

  self.consolidationSweeperTimer = setInterval(() => {
    if (self.consolidationInProgress) return;
    self.consolidationInProgress = true;
    void (async () => {
      try {
        const { promoted, archived, users } = await engine.runConsolidationCycle();
        if (promoted > 0 || archived > 0) {
          console.error(`[BrainRouter] consolidation: promoted ${promoted}, archived ${archived} across ${users} owner(s).`);
        }
      } catch (err) {
        console.error("[BrainRouter] consolidation cycle failed:", err instanceof Error ? err.message : err);
      } finally {
        self.consolidationInProgress = false;
      }
    })();
  }, intervalMs);
  self.consolidationSweeperTimer.unref?.();
}

export function startSessionInboxSweeper(engine: MemoryEngine): void {
  const self = engine as unknown as SweeperState;
  if (process.env.BRAINROUTER_DISABLE_INBOX_SWEEPER === "true") return;
  const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
  const MIN_INTERVAL_MS = 30 * 1000;
  const raw = parseInt(
    process.env.BRAINROUTER_INBOX_SWEEP_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS),
    10,
  );
  if (!Number.isFinite(raw) || raw <= 0) return;
  const intervalMs = Math.max(raw, MIN_INTERVAL_MS);
  const olderThanMs = parseInt(
    process.env.BRAINROUTER_INBOX_SWEEP_MAX_AGE_MS ?? String(60 * 60 * 1000),
    10,
  );
  self.sessionInboxSweeperTimer = setInterval(() => {
    void (async () => {
      try {
        const removed = await engine.store.sweepSessionInbox(olderThanMs);
        if (removed > 0) {
          console.error(`[BrainRouter] session_inbox sweeper removed ${removed} delivered row(s).`);
        }
      } catch (err) {
        console.error(
          "[BrainRouter] session_inbox sweeper failed:",
          err instanceof Error ? err.message : err,
        );
      }
    })();
  }, intervalMs);
  self.sessionInboxSweeperTimer.unref?.();
}
