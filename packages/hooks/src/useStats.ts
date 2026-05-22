import { useEffect, useState } from "react";
import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import type { MemoryStatsResponse } from "@kinqs/brainrouter-types";

export function useStats(client: BrainRouterClient) {
  const [data, setData] = useState<MemoryStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client.getStats().then(setData).catch((e) => setError(String(e)));
  }, [client]);
  return { data, error };
}
