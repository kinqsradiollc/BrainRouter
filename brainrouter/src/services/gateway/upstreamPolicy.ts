import {
  createPinnedLookup,
  validateUpstreamTarget,
  type UpstreamTargetPolicy,
  type ValidatedUpstreamTarget,
} from '@kinqs/brainrouter-core/router';
import { Agent } from 'undici';

export type UpstreamFetchInit = RequestInit & { dispatcher?: unknown };
export type UpstreamFetch = (url: URL, init: UpstreamFetchInit) => Promise<Response>;

export interface UpstreamDispatcherHandle {
  dispatcher: unknown;
  /** Graceful close must allow an in-flight response body to finish. */
  close?: () => void | Promise<void>;
}

export type UpstreamDispatcherFactory = (
  target: ValidatedUpstreamTarget,
) => UpstreamDispatcherHandle;

export interface SafeUpstreamFetchOptions extends UpstreamTargetPolicy {
  fetchImpl?: UpstreamFetch;
  dispatcherFactory?: UpstreamDispatcherFactory;
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const defaultFetch: UpstreamFetch = (url, init) => fetch(url, init as RequestInit);

/** Build an Undici dispatcher whose lookup callback cannot re-query DNS. */
export function createPinnedUndiciDispatcher(
  target: ValidatedUpstreamTarget,
): UpstreamDispatcherHandle {
  const dispatcher = new Agent({
    connect: {
      lookup: createPinnedLookup(target) as never,
    },
  });
  return {
    dispatcher,
    close: () => dispatcher.close(),
  };
}

function closeGracefully(handle: UpstreamDispatcherHandle): void {
  try {
    const closing = handle.close?.();
    if (closing && typeof (closing as Promise<void>).catch === 'function') {
      void (closing as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Closing a one-request dispatcher is best-effort and must not replace the
    // upstream response/error with a cleanup failure.
  }
}

function nextRedirectInit(
  status: number,
  previous: UpstreamFetchInit,
): UpstreamFetchInit {
  const headers = new Headers(previous.headers);
  let method = (previous.method ?? 'GET').toUpperCase();
  let body = previous.body;

  const rewriteToGet = status === 303 && method !== 'GET' && method !== 'HEAD'
    || (status === 301 || status === 302) && method === 'POST';
  if (rewriteToGet) {
    method = 'GET';
    body = undefined;
    headers.delete('content-encoding');
    headers.delete('content-language');
    headers.delete('content-length');
    headers.delete('content-location');
    headers.delete('content-type');
    headers.delete('transfer-encoding');
  } else if ((status === 307 || status === 308) && body instanceof ReadableStream) {
    throw new Error('Cannot safely replay a streaming upstream request body across a redirect.');
  }

  return { ...previous, method, headers, body };
}

function redirectLimit(value: number | undefined): number {
  const limit = value ?? 5;
  if (!Number.isInteger(limit) || limit < 0 || limit > 10) {
    throw new Error('maxRedirects must be an integer between 0 and 10.');
  }
  return limit;
}

/**
 * Fetch an upstream through a newly DNS-pinned dispatcher. Redirect following
 * is manual so every hop gets a fresh URL/DNS policy decision and dispatcher.
 */
export async function fetchUpstreamWithPolicy(
  input: string | URL,
  init: RequestInit = {},
  options: SafeUpstreamFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const dispatcherFactory = options.dispatcherFactory ?? createPinnedUndiciDispatcher;
  const limit = redirectLimit(options.maxRedirects);
  let requestInit: UpstreamFetchInit = { ...init };
  let nextInput = input;

  for (let redirects = 0; ; redirects += 1) {
    const target = await validateUpstreamTarget(nextInput, options);
    const handle = dispatcherFactory(target);
    let response: Response;
    try {
      response = await fetchImpl(target.url, {
        ...requestInit,
        redirect: 'manual',
        dispatcher: handle.dispatcher,
      });
    } finally {
      // Undici's graceful close waits for the active body before resolving, so
      // starting it here prevents connection leaks without truncating streams.
      closeGracefully(handle);
    }

    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
    if (redirects >= limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Upstream redirect limit exceeded (${limit}).`);
    }

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(location, target.url);
    } catch {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Upstream returned an invalid redirect URL.');
    }
    // A reusable transport cannot know every provider-specific secret header.
    // Keeping redirects on the exact origin avoids leaking custom credentials
    // while still allowing ordinary path canonicalization redirects.
    if (redirectUrl.origin !== target.url.origin) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Cross-origin upstream redirects are not permitted.');
    }
    requestInit = nextRedirectInit(response.status, requestInit);
    await response.body?.cancel().catch(() => undefined);
    nextInput = redirectUrl;
  }
}
