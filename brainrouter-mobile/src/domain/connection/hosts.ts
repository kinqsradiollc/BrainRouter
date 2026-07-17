/**
 * Pure saved-hosts list behind the connection manager. A host is a BrainRouter
 * server the app has paired with; the store keeps the list so you can disconnect,
 * reconnect, switch, or remove without re-typing the address.
 */
export interface SavedHost {
  url: string;
  token?: string;
}

/** Add (or move-to-front) a host, trimming the url and normalizing an empty token. */
export function addHost(hosts: SavedHost[], url: string, token?: string): SavedHost[] {
  const u = url.trim();
  if (!u) return hosts;
  const t = token?.trim() || undefined;
  return [{ url: u, token: t }, ...hosts.filter((h) => h.url !== u)];
}

/** Drop a host by url. */
export function removeHost(hosts: SavedHost[], url: string): SavedHost[] {
  return hosts.filter((h) => h.url !== url);
}
