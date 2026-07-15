import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelReasoningEffort } from '@kinqs/brainrouter-types';

import type { ProviderModelRecord } from '../../providers/modelPolicyStore.js';
import { GatewayQuotaError, type GatewayUsageEvent } from './accounting.js';
import type { GatewayAuthContext } from './auth.js';
import { MODEL_INVOKE_SCOPE } from './auth.js';
import type { GatewayResolvedModel } from './modelPolicy.js';
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
    upstreamModelId: 'provider/private-model',
    displayName: 'GPT-5.6 Sol',
    enabled: true,
    isDefault: true,
    sortOrder: 0,
    allowedEfforts: ['high', 'max'],
    defaultEffort: 'high',
    effortWireMap: {
      high: { 'reasoning.effort': 'high' },
      max: { 'reasoning.effort': 'provider-native-max' },
    },
    capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
    capabilitySource: 'verified',
    sourceUrl: 'https://provider.example/models',
    verifiedAt: '2026-07-14T00:00:00.000Z',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

function resolved(
  selectedEffort: ModelReasoningEffort | null = 'high',
  modelOverrides: Partial<ProviderModelRecord> = {},
): GatewayResolvedModel {
  return {
    auth,
    model: model(modelOverrides),
    selectedEffort,
    provider: {
      kind: 'llm',
      endpoint: 'https://provider.example/v1/chat/completions',
      apiKey: 'provider-secret-never-return',
      model: 'ignored',
      models: [],
      wireFormat: 'responses',
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
    requestId: () => 'req_responses_123',
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

async function request(
  svc: GatewayHttpService,
  body: Record<string, unknown>,
  options?: GatewayAppOptions,
): Promise<Response> {
  return requestPath(svc, '/v1/responses', body, options);
}

async function requestPath(
  svc: GatewayHttpService,
  path: '/v1/chat/completions' | '/v1/responses',
  body: Record<string, unknown>,
  options?: GatewayAppOptions,
): Promise<Response> {
  const server = createGatewayApp(svc, options).listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer account-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

describe('hosted Responses data plane', () => {
  it('uses endpoint-specific exact effort fields for one model through both public routes', async () => {
    const dualModel = resolved('high', {
      effortWireMap: {
        high: {
          reasoning_effort: 'native-high',
        },
      },
    });
    const fetchImpl = vi.fn(async (url: URL, _init: UpstreamFetchInit) => url.pathname.endsWith('/responses')
      ? new Response(JSON.stringify({
          id: 'resp_1',
          object: 'response',
          model: 'provider/private-model',
          output: [],
          usage: null,
        }), { headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({
          id: 'chat_1',
          object: 'chat.completion',
          model: 'provider/private-model',
          choices: [],
          usage: null,
        }), { headers: { 'content-type': 'application/json' } }));
    const svc = service({ resolveModel: vi.fn(async () => dualModel) });
    const options = upstreamOptions(fetchImpl);

    const chatResponse = await requestPath(svc, '/v1/chat/completions', {
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'Hello' }],
      reasoning_effort: 'high',
    }, options);
    expect(chatResponse.status).toBe(200);
    await chatResponse.json();

    const responsesResponse = await request(svc, {
      model: 'gpt-5.6-sol',
      input: 'Hello',
      reasoning: { effort: 'high' },
    }, options);
    expect(responsesResponse.status).toBe(200);
    await responsesResponse.json();

    const chatBody = JSON.parse(String(fetchImpl.mock.calls[0]![1].body));
    const responsesBody = JSON.parse(String(fetchImpl.mock.calls[1]![1].body));
    expect(chatBody).toMatchObject({ reasoning_effort: 'native-high' });
    expect(chatBody).not.toHaveProperty('reasoning');
    expect(responsesBody).toMatchObject({ reasoning: { effort: 'native-high' } });
    expect(responsesBody).not.toHaveProperty('reasoning_effort');
  });

  it('proxies non-streaming tools and usage with exact effort and metadata-only audit', async () => {
    const recordUsage = vi.fn(async (_event: GatewayUsageEvent) => undefined);
    const releaseRequest = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (_url: URL, _init: UpstreamFetchInit) => new Response(JSON.stringify({
      id: 'resp_upstream',
      object: 'response',
      status: 'completed',
      error: null,
      model: 'provider/private-model',
      output: [{
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"weather"}',
      }],
      usage: {
        input_tokens: 7,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 3,
        total_tokens: 10,
      },
    }), { headers: { 'content-type': 'application/json' } }));
    const tools = [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }];

    const response = await request(service({
      resolveModel: vi.fn(async () => resolved('max')),
      recordUsage,
      releaseRequest,
    }), {
      model: 'gpt-5.6-sol',
      input: 'Weather?',
      tools,
      tool_choice: 'auto',
      reasoning: { effort: 'max', summary: 'auto' },
    }, upstreamOptions(fetchImpl));
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url.href).toBe('https://provider.example/v1/responses');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'provider/private-model',
      input: 'Weather?',
      tools,
      tool_choice: 'auto',
      reasoning: { summary: 'auto', effort: 'provider-native-max' },
    });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer provider-secret-never-return');
    expect(body).toMatchObject({
      id: 'resp_upstream',
      model: 'gpt-5.6-sol',
      output: [{ type: 'function_call', name: 'lookup' }],
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    });
    expect(JSON.stringify(body)).not.toMatch(/provider-secret|provider\/private-model/);
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledOnce());
    expect(recordUsage).toHaveBeenCalledWith({
      requestId: 'req_responses_123',
      orgId: 'org-1',
      userId: 'user-1',
      servicePrincipalId: null,
      publicModelId: 'gpt-5.6-sol',
      selectedEffort: 'max',
      upstreamRoute: 'provider:pc-1',
      latencyMs: expect.any(Number),
      httpStatus: 200,
      usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, totalTokens: 10 },
      costMicrousd: null,
    });
    expect(JSON.stringify(recordUsage.mock.calls)).not.toMatch(/Weather|provider-secret|account-token/);
    expect(releaseRequest).toHaveBeenCalledWith('org-1', 'req_responses_123');
  });

  it('normalizes streaming response events, tool calls, public model, and terminal usage', async () => {
    const recordUsage = vi.fn(async (_event: GatewayUsageEvent) => undefined);
    const stream = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"provider/private-model","output":[]}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","name":"lookup","call_id":"call_1","arguments":"{}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"provider/private-model","error":null,"output":[],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}\n\n',
    ].join('');
    const fetchImpl = vi.fn(async () => new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    }));

    const response = await request(service({ recordUsage }), {
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: 'Use a tool' }],
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      stream: true,
    }, upstreamOptions(fetchImpl));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('event: response.output_item.done');
    expect(text).toContain('"type":"function_call"');
    expect(text).toContain('"model":"gpt-5.6-sol"');
    expect(text).not.toContain('provider/private-model');
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledOnce());
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      httpStatus: 200,
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    });
  });

  it('preserves canonical sanitized response.failed and error terminal events', async () => {
    for (const fixture of [
      {
        event: 'response.failed',
        stream: 'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_1","model":"provider/private-model","output":[],"error":{"code":"provider_auth","message":"secret sk-live"}}}\n\n',
      },
      {
        event: 'error',
        stream: 'event: error\ndata: {"type":"error","code":"provider_auth","message":"secret sk-live","param":"api_key","sequence_number":3}\n\n',
      },
    ]) {
      const recordUsage = vi.fn(async (_event: GatewayUsageEvent) => undefined);
      const fetchImpl = vi.fn(async () => new Response(fixture.stream, {
        headers: { 'content-type': 'text/event-stream' },
      }));

      const response = await request(service({ recordUsage }), {
        model: 'gpt-5.6-sol',
        input: 'Hello',
        stream: true,
      }, upstreamOptions(fetchImpl));
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain(`event: ${fixture.event}`);
      expect(text).toContain('"code":"upstream_error"');
      expect(text).toContain('The upstream provider could not complete the request.');
      expect(text).not.toMatch(/provider_auth|sk-live|api_key|provider\/private-model/);
      await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
        httpStatus: 502,
        usage: null,
      })));
    }
  });

  it('returns a canonical 429 without contacting upstream when shared quota denies the request', async () => {
    const recordUsage = vi.fn(async (_event: GatewayUsageEvent) => undefined);
    const releaseRequest = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const response = await request(service({
      acquireRequest: vi.fn(async () => {
        throw new GatewayQuotaError('rate_limit_exceeded', 60, 'The model request rate limit has been reached.');
      }),
      recordUsage,
      releaseRequest,
    }), {
      model: 'gpt-5.6-sol',
      input: 'Hello',
    }, upstreamOptions(fetchImpl));
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(body.error.code).toBe('rate_limit_exceeded');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(releaseRequest).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ httpStatus: 429 })));
  });

  it('aborts timed-out upstream work and releases the shared lease', async () => {
    const releaseRequest = vi.fn(async () => undefined);
    const recordUsage = vi.fn(async (_event: GatewayUsageEvent) => undefined);
    const fetchImpl = vi.fn(async (_url: URL, init: UpstreamFetchInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const response = await request(service({ releaseRequest, recordUsage }), {
      model: 'gpt-5.6-sol',
      input: 'Slow request',
    }, upstreamOptions(fetchImpl, 20));
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(504);
    expect(body.error.code).toBe('upstream_timeout');
    await vi.waitFor(() => expect(releaseRequest).toHaveBeenCalledWith('org-1', 'req_responses_123'));
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ httpStatus: 504, usage: null }));
  });

  it('rejects unsupported fields and models without the Responses capability', async () => {
    const resolveModel = vi.fn(async () => resolved());
    const invalid = await request(service({ resolveModel }), {
      model: 'gpt-5.6-sol',
      input: 'Hello',
      orgId: 'org-attacker',
    });
    expect(invalid.status).toBe(400);
    expect(resolveModel).not.toHaveBeenCalled();

    const unavailable = await request(service({
      resolveModel: vi.fn(async () => resolved('high', {
        capabilities: { streaming: true, tools: true, responses: false, reasoning: true },
      })),
    }), {
      model: 'gpt-5.6-sol',
      input: 'Hello',
    });
    const body = await unavailable.json() as { error: { code: string } };
    expect(unavailable.status).toBe(400);
    expect(body.error.code).toBe('unsupported_model_capability');
  });
});
