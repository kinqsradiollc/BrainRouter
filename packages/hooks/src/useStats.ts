import { useEffect, useState } from "react";
import { BrainRouterClient } from "@brainrouter/sdk";

export function useStats(client: BrainRouterClient) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client.getStats().then(setData).catch((e) => setError(String(e)));
  }, [client]);
  return { data, error };
}
