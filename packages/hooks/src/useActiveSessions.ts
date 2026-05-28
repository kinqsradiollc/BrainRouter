import { useEffect, useState } from "react";
import type { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import type { ActiveSessionRecord } from "@kinqs/brainrouter-types";

/**
 * Federation Stage 2 (FED-S2-T7) — live view onto the brain's
 * `active_sessions` registry. Polls every `pollIntervalMs` (default 10s)
 * so the dashboard widget reflects peer comings & goings without a
 * websocket. Heartbeats fire every 30s server-side, so 10s polling is
 * the natural pairing.
 */
export function useActiveSessions(
  client: BrainRouterClient,
  options?: {
    includeStale?: boolean;
    includeUsage?: boolean;
    pollIntervalMs?: number;
    enabled?: boolean;
  },
): { sessions: ActiveSessionRecord[]; error: string | null; isLoading: boolean } {
  const [sessions, setSessions] = useState<ActiveSessionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const includeStale = options?.includeStale ?? false;
  const includeUsage = options?.includeUsage ?? false;
  const enabled = options?.enabled ?? true;
  const pollIntervalMs = options?.pollIntervalMs ?? 10_000;

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;

    const fetchOnce = () => {
      client
        .getRemoteSessions({ includeStale, includeUsage })
        .then((res) => {
          if (cancelled) return;
          setSessions(res.sessions);
          setError(null);
          setIsLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setIsLoading(false);
        });
    };

    fetchOnce();
    const handle = setInterval(fetchOnce, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [client, includeStale, includeUsage, enabled, pollIntervalMs]);

  return { sessions, error, isLoading };
}
