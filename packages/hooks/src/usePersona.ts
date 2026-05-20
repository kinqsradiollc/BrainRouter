import { useCallback, useEffect, useState } from "react";
import { BrainRouterClient } from "@brainrouter/sdk";
import { CoreIdentityRecord } from "@brainrouter/types";

export function usePersona(client: BrainRouterClient) {
  const [persona, setPersona] = useState<CoreIdentityRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    client
      .getPersona()
      .then((r) => setPersona(r.persona))
      .catch((e) => setError(String(e)));
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { persona, error, refresh };
}
