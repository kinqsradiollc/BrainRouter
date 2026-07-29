import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { ProviderRecoveryReceipt } from '@kinqs/brainrouter-types';
import type { Config, LLMConfig } from '../config/config.js';
import { resolveCliKnobs } from '../config/config.js';
import { callOpenAI, callOpenAIStream, type BuildPayloadOptions } from '../agent/transport/llmTransport.js';
import { aggregateCatalog, buildModelRegistry } from './registry.js';
import { resolveRoutes } from './resolve.js';
import { classifyRouterFailure, getRouterPolicy } from './policy.js';
import { executeWithProviderRecovery } from './recovery.js';
import type { CatalogPrefixMode, ModelRegistryEntry } from './routerTypes.js';

/** A non-streaming upstream call — defaults to callOpenAI; injectable for tests. */
export type RouterGatewayTransport = (
  llm: LLMConfig,
  messages: any[],
  tools: any[],
  options?: BuildPayloadOptions,
) => Promise<{ content: string; toolCalls?: any[]; usage?: any; finishReason?: string }>;

/** A streaming upstream call — defaults to callOpenAIStream; injectable for tests. */
export type RouterGatewayStreamTransport = (
  llm: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions,
  handlers: { onTextDelta?: (text: string) => void },
) => Promise<{ content: string; toolCalls?: any[]; usage?: any; finishReason?: string }>;

export interface RouterGatewayOptions {
  config: Config;
  host: string;
  port: number;
  /** Empty ⇒ keyless (loopback). When set, a matching Bearer is required. */
  serveKey?: string;
  transport?: RouterGatewayTransport;
  streamTransport?: RouterGatewayStreamTransport;
  maxAttempts?: number;
  /** Receives one secret-free final receipt for a non-streaming routed call. */
  onRecoveryReceipt?: (receipt: ProviderRecoveryReceipt) => void;
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

/** OpenAI error envelope: { error: { message, type, param, code } }. */
function apiError(
  res: ServerResponse,
  status: number,
  message: string,
  type = 'invalid_request_error',
  code: string | null = null,
  param: string | null = null,
): void {
  json(res, status, { error: { message, type, param, code } });
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let aborted = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (aborted) return;
      raw += chunk;
      if (raw.length > 16_000_000) { aborted = true; req.destroy(); reject(new Error('Request body too large.')); }
    });
    req.on('end', () => {
      if (aborted) return;
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage, serveKey: string | undefined): boolean {
  // Keyless when no serveKey is configured (loopback dev). When a key IS set,
  // require a constant-time Bearer match (mirrors runtime/server.ts).
  if (!serveKey) return true;
  const header = req.headers.authorization ?? '';
  if (Array.isArray(header)) return false;
  const expected = `Bearer ${serveKey}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function registryFor(config: Config) {
  const knobs = resolveCliKnobs(config);
  const baseName = config.providers?.base ? 'base-config' : 'base';
  return buildModelRegistry(
    { ...(config.providers ?? {}), ...(config.llm ? { [baseName]: config.llm } : {}) },
    {
      aliases: knobs.router.aliases,
      chain: [...knobs.router.chain, ...knobs.fallbackModels, ...(config.llm ? [`${baseName}/${config.llm.model}`] : [])],
      order: knobs.router.order,
      strategy: knobs.router.strategy,
      passThrough: knobs.router.passThrough,
      availableModels: knobs.availableModels,
      enforceAvailableModels: knobs.enforceAvailableModels,
    },
  );
}

function catalogPrefix(value: string | null): CatalogPrefixMode {
  return value === 'alias' || value === 'bare' ? value : 'canonical';
}

/** Extract the OpenAI sampling params + tool_choice a client sent, for the transport. */
function transportOptions(body: any): BuildPayloadOptions {
  const opts: BuildPayloadOptions = { passthrough: body };
  const tc = body.tool_choice;
  if (tc === 'auto' || (tc && typeof tc === 'object' && tc.type === 'function')) opts.tool_choice = tc;
  return opts;
}

const newCompletionId = () => `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function chunkFrame(id: string, created: number, model: string, delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  })}\n\n`;
}

function finishReasonFor(result: { toolCalls?: any[]; finishReason?: string }): string {
  if (result.toolCalls && result.toolCalls.length) return 'tool_calls';
  return result.finishReason || 'stop';
}

/** Non-streaming chat.completion object. */
function completionObject(id: string, created: number, model: string, result: Awaited<ReturnType<RouterGatewayTransport>>) {
  const message: any = { role: 'assistant', content: result.content ?? '' };
  if (result.toolCalls && result.toolCalls.length) { message.tool_calls = result.toolCalls; message.content = result.content || null; }
  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReasonFor(result) }],
    usage: result.usage ?? null,
  };
}

/** Walk routes non-streaming, honoring cooldowns + failover (bounded). */
async function executeRoutedChat(
  routes: ModelRegistryEntry[],
  body: any,
  opts: Pick<RouterGatewayOptions, 'transport' | 'maxAttempts' | 'onRecoveryReceipt'>,
) {
  const policy = getRouterPolicy();
  const transport = opts.transport ?? callOpenAI;
  const options = transportOptions(body);
  return executeWithProviderRecovery({
    routes,
    policy,
    maxAttempts: opts.maxAttempts,
    onReceipt: opts.onRecoveryReceipt,
    execute: (route) => transport(route.llm, body.messages ?? [], body.tools ?? [], options),
  });
}

/**
 * Stream OpenAI-compatible SSE. Fails over to the next route ONLY before the
 * first content token (after that the client already holds partial output, so
 * we finish the stream rather than swap models mid-answer — matches the plan).
 */
async function streamRoutedChat(
  res: ServerResponse,
  routes: ModelRegistryEntry[],
  body: any,
  opts: Pick<RouterGatewayOptions, 'streamTransport' | 'maxAttempts'>,
): Promise<void> {
  const policy = getRouterPolicy();
  const stream = opts.streamTransport ?? callOpenAIStream;
  const options = transportOptions(body);
  const includeUsage = body.stream_options?.include_usage === true;
  const id = newCompletionId();
  const created = nowSeconds();
  const tried = new Set<string>();
  let headersSent = false;
  let firstTokenSent = false;
  let lastFailedRoute: ModelRegistryEntry | undefined;
  let lastFailure: ReturnType<typeof classifyRouterFailure> | undefined;
  let lastError: unknown;

  for (let i = 0; i < Math.max(1, opts.maxAttempts ?? 4); i += 1) {
    const route = policy.pickRoute(routes.filter((r) => !tried.has(r.slug)));
    if (!route) break;
    if (lastFailedRoute && lastFailure) policy.noteFallback(lastFailedRoute.slug, route.slug, lastFailure);
    tried.add(route.slug);
    const model = route.model;
    try {
      const result = await stream(route.llm, body.messages ?? [], body.tools ?? [], options, {
        onTextDelta: (text) => {
          if (!text) return;
          if (!headersSent) {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS_HEADERS });
            headersSent = true;
            res.write(chunkFrame(id, created, model, { role: 'assistant', content: '' }, null));
          }
          firstTokenSent = true;
          res.write(chunkFrame(id, created, model, { content: text }, null));
        },
      });
      // Success: open the stream if the reply was empty, emit tool_calls (if any),
      // the terminal finish frame, an optional usage frame, then [DONE].
      if (!headersSent) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS_HEADERS });
        headersSent = true;
        res.write(chunkFrame(id, created, model, { role: 'assistant', content: '' }, null));
      }
      if (result.toolCalls && result.toolCalls.length) {
        res.write(chunkFrame(id, created, model, { tool_calls: result.toolCalls }, null));
      }
      res.write(chunkFrame(id, created, model, {}, finishReasonFor(result)));
      if (includeUsage && result.usage) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: result.usage })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
      policy.noteSuccess(route);
      return;
    } catch (error) {
      lastError = error;
      const failure = classifyRouterFailure(error);
      policy.markFailure(route, failure);
      lastFailedRoute = route; lastFailure = failure;
      // Can only fail over before any bytes reached the client.
      if (firstTokenSent || headersSent || !failure.retryable) break;
    }
  }

  if (headersSent) {
    // Mid-stream failure after output began — close cleanly with a stop frame.
    res.write(chunkFrame(id, created, routes[0]?.model ?? 'router', {}, 'stop'));
    res.end('data: [DONE]\n\n');
    return;
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError ?? 'No route available.');
  apiError(res, 502, msg, 'api_error');
}

export function createRouterGatewayHandler(options: RouterGatewayOptions) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }
      // Accept both `/v1/...` (drop-in OpenAI base_url) and `/router/v1/...`.
      const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`);
      const path = url.pathname.replace(/^\/router\/v1/, '/v1').replace(/\/+$/, '') || '/';

      if (!authorized(req, options.serveKey)) {
        return apiError(res, 401, 'Incorrect API key provided.', 'authentication_error', 'invalid_api_key');
      }
      const registry = registryFor(options.config);

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        const models = aggregateCatalog(registry, {
          prefix: catalogPrefix(url.searchParams.get('prefix')),
          query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? undefined,
        });
        const created = nowSeconds();
        return json(res, 200, {
          object: 'list',
          data: models.map((m) => ({ id: m.id, object: 'model', created, owned_by: m.provider ?? (m.providers?.[0] ?? 'router') })),
        });
      }

      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
        let body: any;
        try { body = await readBody(req); } catch (err) { return apiError(res, 400, err instanceof Error ? err.message : 'Invalid body.', 'invalid_request_error', 'invalid_json'); }
        if (!Array.isArray(body.messages)) return apiError(res, 400, 'Missing required parameter: messages.', 'invalid_request_error', 'invalid_value', 'messages');
        const request = body.model === 'auto' || body.model == null ? '' : String(body.model);
        const routes = resolveRoutes(registry, request, { withFallbacks: true });
        if (routes.length === 0) {
          return apiError(res, 404, `The model \`${body.model ?? 'auto'}\` does not exist or is not routable.`, 'not_found_error', 'model_not_found', 'model');
        }
        if (body.stream === true) {
          return streamRoutedChat(res, routes, body, options);
        }
        const { route, result } = await executeRoutedChat(routes, body, options);
        return json(res, 200, completionObject(newCompletionId(), nowSeconds(), route.model, result));
      }

      return apiError(res, 404, `Unknown route ${req.method} ${path}.`, 'not_found_error', null);
    } catch (error) {
      if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return; }
      const failure = classifyRouterFailure(error);
      const status = failure.status ?? 500;
      apiError(res, status, error instanceof Error ? error.message : String(error), status >= 500 ? 'api_error' : 'invalid_request_error');
    }
  };
}

export function startRouterGateway(options: RouterGatewayOptions): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  const server = http.createServer(createRouterGatewayHandler(options));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : options.port;
      resolve({
        host: options.host,
        port,
        close: () => new Promise((done, fail) => server.close((err) => err ? fail(err) : done())),
      });
    });
  });
}
