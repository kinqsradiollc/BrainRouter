import { useEffect, useState } from "react";
import { BrainRouterClient } from "@brainrouter/sdk";
import type { SkillActivationsResponse } from "@brainrouter/types";

export function useSkillActivations(client: BrainRouterClient) {
  const [data, setData] = useState<SkillActivationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = () => {
    setLoading(true);
    client
      .getSkillActivations()
      .then((res: SkillActivationsResponse) => {
        setData(res);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, [client]);

  return { data, error, loading, refresh };
}
