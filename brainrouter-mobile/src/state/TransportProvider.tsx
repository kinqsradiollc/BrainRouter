/**
 * TransportProvider — makes the single BrainRouterTransport seam available to
 * the tree, and tracks live connection status. Screens consume the transport
 * via `useTransport()` instead of reaching a global, so the Mock and Remote
 * implementations are interchangeable (technical-doc.md §5, §6).
 *
 * M0 wires the MockTransport here so the app boots without a live host; the
 * RemoteTransport lifecycle (the eventual `connectionStore`) slots in later.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { BrainRouterTransport, ConnectionStatus } from '../transport/BrainRouterTransport';

interface TransportContextValue {
  transport: BrainRouterTransport;
  status: ConnectionStatus;
}

const TransportContext = createContext<TransportContextValue | null>(null);

export interface TransportProviderProps {
  transport: BrainRouterTransport;
  children: React.ReactNode;
}

export function TransportProvider({ transport, children }: TransportProviderProps): React.JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>(transport.status());

  useEffect(() => {
    setStatus(transport.status());
    const unsub = transport.onStatus(setStatus);
    return unsub;
  }, [transport]);

  const value = useMemo<TransportContextValue>(() => ({ transport, status }), [transport, status]);

  return <TransportContext.Provider value={value}>{children}</TransportContext.Provider>;
}

export function useTransport(): BrainRouterTransport {
  const ctx = useContext(TransportContext);
  if (!ctx) throw new Error('useTransport must be used within a TransportProvider');
  return ctx.transport;
}

export function useConnectionStatus(): ConnectionStatus {
  const ctx = useContext(TransportContext);
  if (!ctx) throw new Error('useConnectionStatus must be used within a TransportProvider');
  return ctx.status;
}
