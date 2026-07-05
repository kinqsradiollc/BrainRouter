import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { Config, LLMConfig } from '../config/config.js';
import { resolveCliKnobs } from '../config/config.js';
import { callOpenAI, type BuildPayloadOptions } from '../agent/transport/llmTransport.js';
import { aggregateCatalog, buildModelRegistry } from './registry.js';
import { resolveRoutes } from './resolve.js';
import { classifyRouterFailure, getRouterPolicy } from './policy.js';
import type { CatalogPrefixMode, ModelRegistryEntry } from './routerTypes.js';

export type RouterGatewayTransport = (
  llm: LLMConfig,
  messages: any[],
  tools: any[],
  options?: BuildPayloadOptions,
) => Promise<{ content: string; toolCalls?: any[]; usage?: any; finishReason?: string }>;

export interface RouterGatewayOptions {
  config: Config;
  host: string;
  port: number;
  serveKey: string;
  transport?: RouterGatewayTransport;
  maxAttempts?: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 8_000_000) reject(new Error('Request body too large.'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage, serveKey: string): boolean {
  if (!serveKey) return false;
  const header = req.headers.authorization ?? '';
  if (Array.isArray(header)) return false;
  // Constant-time compare so the loopback gateway key can't be recovered by
  // timing the 401 (mirrors runtime/server.ts). Length-guarded because
  // timingSafeEqual throws on a length mismatch.
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

function chatResponse(model: string, result: Awaited<ReturnType<RouterGatewayTransport>>) {
  const message: any = { role: 'assistant', content: result.content };
  if (result.toolCalls) message.tool_calls = result.toolCalls;
  return {
    id: `chatcmpl-router-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: result.finishReason ?? 'stop' }],
    usage: result.usage,
  };
}

function writeSse(res: ServerResponse, model: string, body: unknown): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(body)}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], model })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function executeRoutedChat(
  routes: ModelRegistryEntry[],
  body: any,
  opts: Pick<RouterGatewayOptions, 'transport' | 'maxAttempts'>,
) {
  const policy = getRouterPolicy();
  const transport = opts.transport ?? callOpenAI;
  let lastError: unknown;
  let lastFailedRoute: ModelRegistryEntry | undefined;
  let lastFailure: ReturnType<typeof classifyRouterFailure> | undefined;
  const tried = new Set<string>();
  for (let i = 0; i < Math.max(1, opts.maxAttempts ?? 4); i += 1) {
    const route = policy.pickRoute(routes.filter((r) => !tried.has(r.slug)));
    if (!route) break;
    if (lastFailedRoute && lastFailure) policy.noteFallback(lastFailedRoute.slug, route.slug, lastFailure);
    tried.add(route.slug);
    try {
      const result = await transport(route.llm, body.messages ?? [], body.tools ?? [], { tool_choice: body.tool_choice });
      policy.noteSuccess(route);
      return { route, result };
    } catch (error) {
      lastError = error;
      const failure = classifyRouterFailure(error);
      policy.markFailure(route, failure);
      lastFailedRoute = route;
      lastFailure = failure;
      if (!failure.retryable) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'No route available.'));
}

export function createRouterGatewayHandler(options: RouterGatewayOptions) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!authorized(req, options.serveKey)) return json(res, 401, { error: { message: 'Unauthorized' } });
      const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`);
      const registry = registryFor(options.config);
      if (req.method === 'GET' && url.pathname === '/router/v1/models') {
        return json(res, 200, {
          object: 'list',
          data: aggregateCatalog(registry, {
            prefix: catalogPrefix(url.searchParams.get('prefix')),
            query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? undefined,
          }),
        });
      }
      if (req.method !== 'POST' || url.pathname !== '/router/v1/chat/completions') {
        return json(res, 404, { error: { message: 'Not found' } });
      }
      const body = await readBody(req);
      const request = body.model === 'auto' ? '' : String(body.model ?? '');
      const routes = resolveRoutes(registry, request, { withFallbacks: true });
      if (routes.length === 0) return json(res, 400, { error: { message: `No route for model "${body.model ?? 'auto'}".` } });
      const { route, result } = await executeRoutedChat(routes, body, options);
      const payload = chatResponse(route.model, result);
      if (body.stream === true) return writeSse(res, route.model, payload);
      return json(res, 200, payload);
    } catch (error) {
      return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
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
