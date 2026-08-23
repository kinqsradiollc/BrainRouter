import { describe, expect, it, vi } from 'vitest';

import {
  fetchUpstreamWithPolicy,
  createPinnedUndiciDispatcher,
  directDialer,
  type EdgeDialer,
  type UpstreamDispatcherHandle,
  type UpstreamFetchInit,
} from './upstreamPolicy.js';

const addresses = {
  'api.example.com': [{ address: '93.184.216.34', family: 4 as const }],
};

const resolve = vi.fn(async (hostname: string) => addresses[hostname as keyof typeof addresses] ?? []);

function harness(responses: Response[]) {
  const fetchImpl = vi.fn(async (_url: URL, _init: UpstreamFetchInit): Promise<Response> => {
    const response = responses.shift();
    if (!response) throw new Error('unexpected fetch');
    return response;
  });
  const handles: UpstreamDispatcherHandle[] = [];
  const dispatcherFactory = vi.fn((target) => {
    const handle = { dispatcher: { target }, close: vi.fn(async () => undefined) };
    handles.push(handle);
    return handle;
  });
  return { fetchImpl, dispatcherFactory, handles };
}

describe('SSRF-safe upstream transport', () => {
  it('disables automatic redirects and passes DNS-pinned addresses to the dispatcher', async () => {
    const h = harness([new Response('ok', { status: 200 })]);

    const response = await fetchUpstreamWithPolicy('https://api.example.com/v1/chat', {
      method: 'POST',
      body: '{}',
    }, {
      mode: 'hosted',
      resolve,
      fetchImpl: h.fetchImpl,
      dispatcherFactory: h.dispatcherFactory,
    });

    expect(await response.text()).toBe('ok');
    expect(h.dispatcherFactory).toHaveBeenCalledWith(expect.objectContaining({
      hostname: 'api.example.com',
      addresses: [{ address: '93.184.216.34', family: 4 }],
    }));
    expect(h.fetchImpl).toHaveBeenCalledWith(
      new URL('https://api.example.com/v1/chat'),
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        dispatcher: h.handles[0]?.dispatcher,
      }),
    );
    expect(h.handles[0]?.close).toHaveBeenCalledOnce();
  });

  it('manually revalidates each same-origin redirect with a fresh pinned dispatcher', async () => {
    const h = harness([
      new Response(null, { status: 307, headers: { location: '/v1/redirected' } }),
      new Response('redirected', { status: 200 }),
    ]);

    const response = await fetchUpstreamWithPolicy('https://api.example.com/v1/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer upstream-secret',
        cookie: 'session=secret',
        'content-type': 'application/json',
      },
      body: '{}',
    }, {
      resolve,
      fetchImpl: h.fetchImpl,
      dispatcherFactory: h.dispatcherFactory,
    });

    expect(await response.text()).toBe('redirected');
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.dispatcherFactory.mock.calls.map(([target]) => target.hostname)).toEqual([
      'api.example.com',
      'api.example.com',
    ]);
    const redirectedInit = h.fetchImpl.mock.calls[1]?.[1];
    const redirectedHeaders = new Headers(redirectedInit?.headers);
    expect(redirectedHeaders.get('authorization')).toBe('Bearer upstream-secret');
    expect(redirectedHeaders.get('cookie')).toBe('session=secret');
    expect(redirectedHeaders.get('content-type')).toBe('application/json');
  });

  it('rejects cross-origin redirects because custom provider credential headers cannot be identified safely', async () => {
    const h = harness([
      new Response(null, { status: 302, headers: { location: 'https://redirect.example/v1' } }),
    ]);

    await expect(fetchUpstreamWithPolicy('https://api.example.com/v1', {}, {
      resolve,
      fetchImpl: h.fetchImpl,
      dispatcherFactory: h.dispatcherFactory,
    })).rejects.toThrow(/cross-origin/i);
    expect(h.fetchImpl).toHaveBeenCalledOnce();
  });

  it('re-resolves a same-origin redirect and blocks a rebinding answer before the next request', async () => {
    const h = harness([
      new Response(null, { status: 302, headers: { location: '/internal' } }),
    ]);
    let resolution = 0;
    const rebindingResolve = vi.fn(async () => {
      resolution += 1;
      return resolution === 1
        ? [{ address: '93.184.216.34', family: 4 as const }]
        : [{ address: '10.0.0.7', family: 4 as const }];
    });

    await expect(fetchUpstreamWithPolicy('https://api.example.com/v1', {}, {
      resolve: rebindingResolve,
      fetchImpl: h.fetchImpl,
      dispatcherFactory: h.dispatcherFactory,
    })).rejects.toThrow(/private/i);
    expect(rebindingResolve).toHaveBeenCalledTimes(2);
    expect(h.fetchImpl).toHaveBeenCalledOnce();
  });

  it('permits an exact self-hosted HTTP/private origin without weakening other origins', async () => {
    const h = harness([new Response('local', { status: 200 })]);
    const privateResolve = vi.fn(async () => [{ address: '10.0.0.8', family: 4 as const }]);

    await expect(fetchUpstreamWithPolicy('http://ollama.internal:11434/v1', {}, {
      mode: 'self-hosted',
      allowlist: ['http://ollama.internal:11434'],
      resolve: privateResolve,
      fetchImpl: h.fetchImpl,
      dispatcherFactory: h.dispatcherFactory,
    })).resolves.toBeInstanceOf(Response);

    await expect(fetchUpstreamWithPolicy('http://ollama.internal:11435/v1', {}, {
      mode: 'self-hosted',
      allowlist: ['http://ollama.internal:11434'],
      resolve: privateResolve,
      fetchImpl: h.fetchImpl,
      dispatcherFactory: h.dispatcherFactory,
    })).rejects.toThrow(/allowlist/i);
  });
});

describe('ADR-043 S2 — EdgeDialer seam (D6)', () => {
  it('directDialer is the exported default and is byte-identical to the pinned dispatcher', () => {
    expect(directDialer).toBe(createPinnedUndiciDispatcher);
  });

  it('a custom EdgeDialer is selected over the default when provided (seam is live)', async () => {
    let dialed = false;
    const customDialer: EdgeDialer = (target) => {
      dialed = true;
      return { dispatcher: undefined, close: () => {} };
    };
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await fetchUpstreamWithPolicy('https://api.example.com/v1', {}, {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      dispatcherFactory: customDialer,
      fetchImpl,
    });
    expect(dialed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

