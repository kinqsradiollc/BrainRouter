/**
 * connectionStore — owns the single active BrainRouterTransport plus the saved-
 * hosts list, so the pairing UI can connect, disconnect (→ demo mock), reconnect,
 * switch between hosts, and add/forget hosts. The previous transport is disposed on
 * every swap so sockets/listeners don't leak. Hosts are kept in-memory for the
 * session (cross-restart persistence is a later, dev-build/SecureStore slice).
 */
import { create } from 'zustand';
import type { BrainRouterTransport } from '../transport/BrainRouterTransport';
import { MockTransport } from '../transport/MockTransport';
import { RemoteTransport } from '../transport/RemoteTransport';
import { addHost, removeHost, type SavedHost } from '../domain/connection/hosts';

export type TransportMode = 'mock' | 'remote';

interface ConnectionStore {
  transport: BrainRouterTransport;
  mode: TransportMode;
  /** Saved hosts (most-recent first). */
  hosts: SavedHost[];
  /** The host url the app is connected to (or was, before disconnecting). */
  activeUrl: string | null;
  /** Pair with a host (saves it + swaps to a live RemoteTransport). */
  connect: (url: string, token?: string) => void;
  /** Reconnect / switch to an already-saved host. */
  connectTo: (url: string) => void;
  /** Drop the live connection and return to the demo mock (keeps the host saved). */
  disconnect: () => void;
  /** Reconnect to the last-used host (or the most-recent saved one). */
  reconnect: () => void;
  /** Forget a saved host. */
  forgetHost: (url: string) => void;
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  transport: new MockTransport(),
  mode: 'mock',
  hosts: [],
  activeUrl: null,
  connect: (url, token) => {
    const u = url.trim();
    if (!u) return;
    const prev = get().transport;
    set({
      transport: new RemoteTransport({ url: u, token: token?.trim() || undefined }),
      mode: 'remote',
      activeUrl: u,
      hosts: addHost(get().hosts, u, token),
    });
    prev.dispose();
  },
  connectTo: (url) => {
    const host = get().hosts.find((h) => h.url === url);
    if (host) get().connect(host.url, host.token);
  },
  disconnect: () => {
    if (get().mode === 'mock') return;
    const prev = get().transport;
    set({ transport: new MockTransport(), mode: 'mock' }); // keep activeUrl + hosts for reconnect
    prev.dispose();
  },
  reconnect: () => {
    const url = get().activeUrl ?? get().hosts[0]?.url;
    if (url) get().connectTo(url);
  },
  forgetHost: (url) => {
    set({ hosts: removeHost(get().hosts, url), activeUrl: get().activeUrl === url ? null : get().activeUrl });
  },
}));
