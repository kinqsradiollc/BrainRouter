import { useCallback, useState } from "react";
import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import type {
  WorkingContextRequest,
  WorkingContextResponse,
  WorkingOffloadRequest,
  WorkingOffloadResponse,
  WorkingResetRequest,
  WorkingResetResponse,
  ActiveSessionInfo,
} from "@kinqs/brainrouter-types";

export function useWorkingMemory(client: BrainRouterClient) {
  const [context, setContext] = useState<WorkingContextResponse | null>(null);
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const response = await client.getActiveSessions();
      setSessions(response.sessions);
      return response.sessions;
    } catch (e) {
      // Ignore sessions list error to prevent breaking main memory view
      return [];
    }
  }, [client]);

  const loadContext = useCallback(async (request: WorkingContextRequest) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await client.getWorkingContext(request);
      setContext(response);
      return response;
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  const offload = useCallback(async (request: WorkingOffloadRequest): Promise<WorkingOffloadResponse> => {
    const response = await client.offloadWorkingPayload(request);
    await loadContext({ sessionKey: request.sessionKey, workspacePath: request.workspacePath });
    await loadSessions();
    return response;
  }, [client, loadContext, loadSessions]);

  const reset = useCallback(async (request: WorkingResetRequest): Promise<WorkingResetResponse> => {
    const response = await client.resetWorkingMemory(request);
    setContext(null);
    await loadSessions();
    return response;
  }, [client, loadSessions]);

  return { context, sessions, error, isLoading, loadContext, loadSessions, offload, reset };
}
