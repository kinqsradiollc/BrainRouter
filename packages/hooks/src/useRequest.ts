/**
 * Shared React request-state primitives.
 *
 * Queries and mutations are scope-aware, abort obsolete work, and never commit
 * a response after its owning workspace or resource scope changes.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface QuerySnapshot<T> {
  scopeKey: string;
  value: T;
}

interface ErrorSnapshot {
  scopeKey: string;
  value: string | null;
}

export function useRequestQuery<T>(
  scopeKey: string,
  enabled: boolean,
  emptyValue: T,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const [snapshot, setSnapshot] = useState<QuerySnapshot<T>>({ scopeKey, value: emptyValue });
  const [errorSnapshot, setErrorSnapshot] = useState<ErrorSnapshot>({ scopeKey, value: null });
  const [loadingScope, setLoadingScope] = useState<string | null>(enabled ? scopeKey : null);
  const [reloadToken, setReloadToken] = useState(0);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!enabled) {
      setSnapshot({ scopeKey, value: emptyValue });
      setErrorSnapshot({ scopeKey, value: null });
      setLoadingScope(null);
      return;
    }

    const controller = new AbortController();
    setLoadingScope(scopeKey);
    setErrorSnapshot({ scopeKey, value: null });
    void load(controller.signal)
      .then((value) => {
        if (requestId !== requestIdRef.current || controller.signal.aborted) return;
        setSnapshot({ scopeKey, value });
      })
      .catch((error: unknown) => {
        if (requestId !== requestIdRef.current || isAbortError(error)) return;
        setErrorSnapshot({ scopeKey, value: errorMessage(error) });
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoadingScope(null);
      });

    return () => {
      requestIdRef.current += 1;
      controller.abort();
    };
  }, [emptyValue, enabled, load, reloadToken, scopeKey]);

  const reload = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

  return {
    value: snapshot.scopeKey === scopeKey ? snapshot.value : emptyValue,
    error: errorSnapshot.scopeKey === scopeKey ? errorSnapshot.value : null,
    isLoading: enabled && (
      loadingScope === scopeKey
      || (snapshot.scopeKey !== scopeKey && errorSnapshot.scopeKey !== scopeKey)
    ),
    reload,
  };
}

interface MutationState {
  scopeKey: string;
  pending: number;
  error: string | null;
}

export function useRequestMutation(scopeKey: string, latestOnly = false) {
  const scopeKeyRef = useRef(scopeKey);
  const controllersRef = useRef(new Set<AbortController>());
  const [state, setState] = useState<MutationState>({ scopeKey, pending: 0, error: null });
  scopeKeyRef.current = scopeKey;

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, [scopeKey]);

  const run = useCallback(async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const requestedScope = scopeKey;
    if (latestOnly) {
      for (const active of controllersRef.current) active.abort();
      controllersRef.current.clear();
    }
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setState((current) => ({
      scopeKey: requestedScope,
      pending: current.scopeKey === requestedScope ? current.pending + 1 : 1,
      error: null,
    }));

    try {
      const value = await operation(controller.signal);
      if (controller.signal.aborted || scopeKeyRef.current !== requestedScope) {
        throw new DOMException("The request scope changed", "AbortError");
      }
      return value;
    } catch (error) {
      if (!isAbortError(error) && scopeKeyRef.current === requestedScope) {
        setState((current) => ({
          scopeKey: requestedScope,
          pending: current.scopeKey === requestedScope ? current.pending : 0,
          error: errorMessage(error),
        }));
      }
      throw error;
    } finally {
      controllersRef.current.delete(controller);
      if (scopeKeyRef.current === requestedScope) {
        setState((current) => ({
          ...current,
          scopeKey: requestedScope,
          pending: Math.max(0, (current.scopeKey === requestedScope ? current.pending : 1) - 1),
        }));
      }
    }
  }, [latestOnly, scopeKey]);

  return {
    run,
    isMutating: state.scopeKey === scopeKey && state.pending > 0,
    error: state.scopeKey === scopeKey ? state.error : null,
  };
}
