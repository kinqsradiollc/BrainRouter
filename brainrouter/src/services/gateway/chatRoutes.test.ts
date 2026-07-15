import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelReasoningEffort } from '@kinqs/brainrouter-types';

import type { ProviderModelRecord } from '../../providers/modelPolicyStore.js';
import type { GatewayAuthContext } from './auth.js';
import { MODEL_INVOKE_SCOPE } from './auth.js';
import {
  GatewayModelPolicyError,
  type GatewayResolvedModel,
} from './modelPolicy.js';
import {
  createGatewayApp,
  type GatewayAppOptions,
  type GatewayHttpService,
} from './server.js';
import type { UpstreamFetch, UpstreamFetchInit } from './upstreamPolicy.js';

const auth: GatewayAuthContext = {
  credentialType: 'jwt',
  principalType: 'user',
  userId: 'user-1',
  orgId: 'org-1',
  role: 'developer',
  scopes: [MODEL_INVOKE_SCOPE],
};

function model(overrides: Partial<ProviderModelRecord> = {}): ProviderModelRecord {
  return {
    id: 'pm-1',
    orgId: 'org-1',
    providerConfigId: 'pc-1',
    publicModelId: 'gpt-5.6-sol',
    upstreamModelId: 'provider/internal-gpt-5.6',
    displayName: 'GPT-5.6 Sol',
    enabled: true,
    isDefault: true,
    sortOrder: 0,
    allowedEfforts: ['none', 'high', 'max'],
    defaultEffort: 'high',
    effortWireMap: {
      none: { 'reasoning.effort': 'none' },
      high: { reasoning_effort: 'high' },
      max: { 'output_config.effort': 'provider-native-max' },
    },
    capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
    capabilitySource: 'verified',
    sourceUrl: 'https://provider.example/models/gpt-5.6',
    verifiedAt: '2026-07-14T00:00:00.000Z',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

function resolved(selectedEffort: ModelReasoningEffort | null = 'high'): GatewayResolvedModel {
  return {
    auth,
    model: model(),
    selectedEffort,
    provider: {
      kind: 'llm',
      endpoint: 'https://provider.example/v1',
      apiKey: 'upstream-secret-do-not-return',
      model: 'ignored-default',
      models: [],
      wireFormat: 'chat-completions',
      extra: {},
      source: 'db',
    },
  };
}

function service(overrides: Partial<GatewayHttpService> = {}): GatewayHttpService {
  return {
    ping: vi.fn(async () => true),
    authenticate: vi.fn(async () => auth),
    listModels: vi.fn(async () => [model()]),
    resolveModel: vi.fn(async (_auth, _modelId, effort) => (
      resolved((effort ?? 'high') as ModelReasoningEffort)
    )),
    acquireRequest: vi.fn(async () => undefined),
    releaseRequest: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
    ...overrides,
  };
}

function upstreamOptions(fetchImpl: UpstreamFetch, timeoutMs = 1_000): GatewayAppOptions {
  return {
    requestId: () => 'req_fixture_123',
    timeoutMs,
    upstream: {
      resolve: vi.fn(async () => [{ address: '8.8.8.8', family: 4 as const }]),
      fetchImpl,
      dispatcherFactory: vi.fn((target) => ({
        dispatcher: { hostname: target.hostname, addresses: target.addresses },
        close: vi.fn(async () => undefined),
      })),
    },
  };
}

const servers: import('node:http').Server[] = [];

async function start(svc: GatewayHttpService, options?: GatewayAppOptions): Promise<string> {
  const server = createGatewayApp(svc, options).listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

async function jsonRequest(
  svc: GatewayHttpService,
  path: string,
  init: RequestInit = {},
  options?: GatewayAppOptions,
): Promise<{ response: Response; body: any }> {
  const baseUrl = await start(svc, options);
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: 'Bearer account-token', ...init.headers },
  });
  return { response, body: await response.json() };
}

describe('hosted Chat Completions data plane', () => {
  it('lists only enabled public model IDs without upstream routing or credentials', async () => {
    const listModels = vi.fn(async () => [
      model(),
      model({ id: 'pm-2', publicModelId: 'disabled-model', upstreamModelId: 'secret-disabled', enabled: false }),
    ]);
    const { response, body } = await jsonRequest(service({ listModels }), '/v1/models');

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toMatch(/^req_/);
    expect(listModels).toHaveBeenCalledWith(auth);
    expect(body).toEqual({
      object: 'list',
      data: [{
        id: 'gpt-5.6-sol',
        object: 'model',
        created: 1783987200,
        owned_by: 'brainrouter',
      }],
    });
    expect(JSON.stringify(body)).not.toMatch(/internal-gpt|secret-disabled|api.?key/i);
  });

  it('proxies non-streaming tools and usage while applying the exact selected effort', async () => {
    const fetchImpl = vi.fn(async (_url: URL, _init: UpstreamFetchInit) => new Response(JSON.stringify({
      id: 'chatcmpl-upstream',
      object: 'chat.completion',
      created: 1783987200,
      model: 'provider/internal-gpt-5.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"weather"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const resolveModel = vi.fn(async () => resolved('max'));
    const recordUsage = vi.fn(async () => undefined);
    const tools = [{
      type: 'function',
      function: { name: 'lookup', description: 'Look up data', parameters: { type: 'object' } },
    }];

    const { response, body } = await jsonRequest(service({ resolveModel, recordUsage }), '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'Weather?' }],
        tools,
        tool_choice: 'auto',
        reasoning_effort: 'max',
      }),
    }, upstreamOptions(fetchImpl));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req_fixture_123');
    expect(resolveModel).toHaveBeenCalledWith(auth, 'gpt-5.6-sol', 'max');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url.href).toBe('https://provider.example/v1/chat/completions');
    const upstreamBody = JSON.parse(String(init.body));
    expect(upstreamBody).toEqual({
      model: 'provider/internal-gpt-5.6',
      messages: [{ role: 'user', content: 'Weather?' }],
      tools,
      tool_choice: 'auto',
      output_config: { effort: 'provider-native-max' },
    });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer upstream-secret-do-not-return');
    expect(new Headers(init.headers).get('x-request-id')).toBe('req_fixture_123');
    expect(body.model).toBe('gpt-5.6-sol');
    expect(body.choices[0].message.tool_calls).toEqual([{
      id: 'call_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":"weather"}' },
    }]);
    expect(body.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    expect(JSON.stringify(body)).not.toMatch(/upstream-secret|provider\/internal/i);
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req_fixture_123',
      orgId: 'org-1',
      publicModelId: 'gpt-5.6-sol',
      selectedEffort: 'max',
      upstreamRoute: 'provider:pc-1',
      httpStatus: 200,
      usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: null, totalTokens: 10 },
    })));
    expect(JSON.stringify(recordUsage.mock.calls)).not.toMatch(/Weather|upstream-secret|account-token/);
  });

  it('rejects body tenant scope, unknown fields, and conflicting effort forms before model custody', async () => {
    for (const invalid of [
      { orgId: 'org-attacker' },
      { unsupported_option: true },
      { reasoning_effort: 'high', reasoning: { effort: 'max' } },
    ]) {
      const resolveModel = vi.fn(async () => resolved());
      const { response, body } = await jsonRequest(service({ resolveModel }), '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hello' }],
          ...invalid,
        }),
      });

      expect(response.status).toBe(400);
      expect(body.error).toMatchObject({ type: 'invalid_request_error' });
      expect(resolveModel).not.toHaveBeenCalled();
    }
  });

  it('returns a canonical invalid-effort error without exposing model custody', async () => {
    const resolveModel = vi.fn(async () => {
      throw new GatewayModelPolicyError(
        400,
        'invalid_reasoning_effort',
        'Reasoning effort low is not enabled for gpt-5.6-sol.',
      );
    });
    const { response, body } = await jsonRequest(service({ resolveModel }), '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning: { effort: 'low' },
      }),
    });

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        message: 'Reasoning effort low is not enabled for gpt-5.6-sol.',
        type: 'invalid_request_error',
        param: 'reasoning_effort',
        code: 'invalid_reasoning_effort',
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/upstream-secret|provider\/internal/i);
  });

  it('normalizes streaming SSE model IDs and passes through tool-call deltas and DONE', async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-s","model":"provider/internal-gpt-5.6","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}\n'));
        controller.enqueue(encoder.encode('\ndata: {"id":"chatcmpl-s","model":"provider/internal-gpt-5.6","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"weather\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(upstream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const baseUrl = await start(service(), upstreamOptions(fetchImpl));
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer account-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'Weather?' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(text).toContain('"model":"gpt-5.6-sol"');
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('weather');
    expect(text).toContain('data: [DONE]\n\n');
    expect(text).not.toContain('provider/internal-gpt-5.6');
  });

  it('times out an upstream request with a canonical error and abort signal', async () => {
    const captured: { signal?: AbortSignal } = {};
    const fetchImpl: UpstreamFetch = vi.fn(async (_url, init) => {
      if (init.signal) captured.signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });

    const { response, body } = await jsonRequest(service(), '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }] }),
    }, upstreamOptions(fetchImpl, 10));

    expect(response.status).toBe(504);
    expect(captured.signal?.aborted).toBe(true);
    expect(body).toEqual({
      error: {
        message: 'The upstream model request timed out.',
        type: 'timeout_error',
        param: null,
        code: 'upstream_timeout',
      },
    });
  });

  it('sanitizes upstream authentication and payload errors without reading their secrets', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: 'bad upstream-secret-do-not-return at https://provider.example/v1',
      },
    }), { status: 401, headers: { 'content-type': 'application/json' } }));

    const { response, body } = await jsonRequest(service(), '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }] }),
    }, upstreamOptions(fetchImpl));

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: {
        message: 'The upstream provider could not complete the request.',
        type: 'api_error',
        param: null,
        code: 'upstream_authentication_error',
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/upstream-secret|provider\.example/i);
  });

  it('aborts the upstream transport when the downstream client disconnects', async () => {
    let started!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => { started = resolve; });
    let upstreamAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { upstreamAborted = resolve; });
    const fetchImpl: UpstreamFetch = vi.fn(async (_url, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          upstreamAborted();
          reject(init.signal?.reason);
        }, { once: true });
      });
    });
    const baseUrl = await start(service(), upstreamOptions(fetchImpl, 5_000));
    const downstreamAbort = new AbortController();
    const request = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: downstreamAbort.signal,
      headers: { authorization: 'Bearer account-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }] }),
    });

    await upstreamStarted;
    downstreamAbort.abort();
    await expect(request).rejects.toThrow();
    await expect(aborted).resolves.toBeUndefined();
  });
});
