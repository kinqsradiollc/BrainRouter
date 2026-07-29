/**
 * Embedded-browser destination policy.
 *
 * Owns DNS preflight and private-address rules independently of Electron view
 * lifecycle. Agent navigation is fail-closed; a human tab may use ordinary
 * private destinations, while an agent needs the exact trusted origin.
 *
 * A25-6a: keep destination authority testable without constructing Electron
 * views or sessions.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  isMetadataOrLinkLocalAddress,
  isPrivateOrLocalAddress,
} from '../webviewPolicy.js';

export type BrowserHostResolver = (
  host: string,
  fresh: boolean,
) => Promise<string[]>;

export interface BrowserDestinationAgentPolicy {
  allowedPrivateOrigin?: string;
}

export async function resolvedBrowserDestinationAllowed(
  rawUrl: string,
  agentPolicy?: BrowserDestinationAgentPolicy,
  resolver?: BrowserHostResolver,
): Promise<boolean> {
  let host = '';
  let origin = '';
  try {
    const url = new URL(rawUrl);
    host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    origin = url.origin;
  } catch {
    return false;
  }
  if (!host) return false;
  const privateAllowed = Boolean(
    agentPolicy?.allowedPrivateOrigin
    && agentPolicy.allowedPrivateOrigin === origin,
  );
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return !agentPolicy || privateAllowed;
  }
  if (isIP(host)) {
    return !isMetadataOrLinkLocalAddress(host)
      && (!agentPolicy || !isPrivateOrLocalAddress(host) || privateAllowed);
  }

  let allow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolver
        ? resolver(host, Boolean(agentPolicy)).then((rows) =>
            rows.map((address) => ({ address })))
        : lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('DNS resolution timed out.')),
          2_000,
        );
      }),
    ]);
    allow = addresses.length > 0 && addresses.every((entry) =>
      !isMetadataOrLinkLocalAddress(entry.address)
      && (!agentPolicy
        || !isPrivateOrLocalAddress(entry.address)
        || privateAllowed));
  } catch {
    allow = false;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return allow;
}
