import { useCallback, useEffect, useState } from "react";
import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import type { DiagnosticsBundle } from "@kinqs/brainrouter-types";

export function useDiagnostics(
  client: BrainRouterClient,
  userId?: string,
  options?: { enabled?: boolean }
) {
  const [data, setData] = useState<DiagnosticsBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (options?.enabled === false) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await client.getDiagnostics(userId);
      setData(response);
      return response;
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, [client, userId, options?.enabled]);

  useEffect(() => {
    if (options?.enabled !== false) {
      void refresh();
    } else {
      setData(null);
      setError(null);
      setIsLoading(false);
    }
  }, [refresh, options?.enabled]);

  return { data, error, isLoading, refresh };
}
