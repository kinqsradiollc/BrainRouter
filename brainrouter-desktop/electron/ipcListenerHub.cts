/**
 * D26-5 — renderer subscription fan-out for a single preload IPC channel.
 *
 * React surfaces can subscribe independently without adding one native
 * ipcRenderer listener per mounted surface. The native listener exists only
 * while the hub has subscribers and is detached after the last unsubscribe.
 */

type NativeListener = (event: unknown, payload: unknown) => void;

interface IpcListenerSource {
  on(channel: string, listener: NativeListener): unknown;
  removeListener(channel: string, listener: NativeListener): unknown;
}

export interface IpcListenerHub<T> {
  subscribe(listener: (payload: T) => void): () => void;
}

export function createIpcListenerHub<T>(
  source: IpcListenerSource,
  channel: string,
): IpcListenerHub<T> {
  const subscribers = new Set<(payload: T) => void>();
  let attached = false;

  const forward: NativeListener = (_event, payload) => {
    for (const subscriber of [...subscribers]) subscriber(payload as T);
  };

  const attach = () => {
    if (attached) return;
    source.on(channel, forward);
    attached = true;
  };

  const detach = () => {
    if (!attached) return;
    source.removeListener(channel, forward);
    attached = false;
  };

  return {
    subscribe(listener) {
      // Each call owns a distinct registration even when a caller deliberately
      // subscribes the same callback more than once.
      const subscription = (payload: T) => listener(payload);
      subscribers.add(subscription);
      attach();

      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        subscribers.delete(subscription);
        if (subscribers.size === 0) detach();
      };
    },
  };
}
