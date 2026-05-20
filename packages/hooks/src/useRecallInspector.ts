import { useCallback, useState } from "react";
import { BrainRouterClient } from "@brainrouter/sdk";
import type { ExplainRecallRequest, ExplainRecallResponse } from "@brainrouter/types";

export function useRecallInspector(client: BrainRouterClient) {
  const [result, setResult] = useState<ExplainRecallResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const explain = useCallback(async (request: ExplainRecallRequest) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await client.explainRecall(request);
      setResult(response);
      return response;
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  return { result, error, isLoading, explain, setResult };
}
