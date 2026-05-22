import { useCallback, useEffect, useState } from "react";
import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import type {
  HookRegisterRequest,
  HookRegisterResponse,
  HookStatusParams,
  RegisteredHook,
} from "@kinqs/brainrouter-types";

export function useHookStatus(client: BrainRouterClient, params: HookStatusParams = {}) {
  const [hooks, setHooks] = useState<RegisteredHook[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paramsKey = JSON.stringify(params);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await client.getHookStatus(JSON.parse(paramsKey) as HookStatusParams);
      setHooks(response.hooks);
      return response;
    } catch (e) {
      setError(String(e));
      setHooks([]);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, [client, paramsKey]);

  const register = useCallback(async (request: HookRegisterRequest): Promise<HookRegisterResponse> => {
    const response = await client.registerHook(request);
    await refresh();
    return response;
  }, [client, refresh]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  return { hooks, error, isLoading, refresh, register };
}
