/**
 * connectionStore — owns the single active BrainRouterTransport and lets the
 * pairing flow swap MockTransport ↔ RemoteTransport at runtime. The app boots on
 * the in-memory MockTransport (usable immediately with canned data); `connect()`
 * pairs with a live `brainrouter-host` over WebSocket. The previous transport is
 * disposed on every swap so sockets/listeners don't leak.
 */
import { create } from 'zustand';
import type { BrainRouterTransport } from '../transport/BrainRouterTransport';
import { MockTransport } from '../transport/MockTransport';
import { RemoteTransport } from '../transport/RemoteTransport';

export type TransportMode = 'mock' | 'remote';

interface ConnectionStore {
  transport: BrainRouterTransport;
  mode: TransportMode;
  /** Pair with a live host (swaps to RemoteTransport). */
  connect: (url: string, token?: string) => void;
  /** Return to the in-memory MockTransport (demo / disconnect). */
  useMock: () => void;
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  transport: new MockTransport(),
  mode: 'mock',
  connect: (url, token) => {
    const prev = get().transport;
    set({ transport: new RemoteTransport({ url, token }), mode: 'remote' });
    prev.dispose();
  },
  useMock: () => {
    const prev = get().transport;
    set({ transport: new MockTransport(), mode: 'mock' });
    prev.dispose();
  },
}));
