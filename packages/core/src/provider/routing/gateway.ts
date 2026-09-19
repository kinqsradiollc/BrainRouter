/**
 * Purpose: Serve the provider-owned OpenAI-compatible routing gateway.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { ProviderRecoveryReceipt } from '@kinqs/brainrouter-types';
import type { Config, LLMConfig } from '../../config/config.js';
import { resolveCliKnobs } from '../../config/config.js';
import { callOpenAI, type BuildPayloadOptions } from '../../agent/transport/llmTransport.js';
// ADR-041 A41-5 — the gateway consumes the provider-neutral StreamChunk stream.
import { callProviderStream, type StreamChunk, type ProviderStreamResult } from '../../agent/transport/providerStream.js';
import { aggregateCatalog, buildModelRegistry } from './registry.js';
import { resolveRoutes } from './resolve.js';
import { chooseStartingRoute } from './routeDecision.js';
import { decisionPortForSession } from '../../decision/fromKnobs.js';
import { decisionEntry, type DecisionEntry } from '../../decision/recentDecisions.js';
import { redactText } from '../../session/transcript/sessionStore.js';
import { classifyRouterFailure, getRouterPolicy } from './policy.js';
import { executeWithProviderRecovery } from './recovery.js';
import type { CatalogPrefixMode, ModelRegistryEntry } from './types.js';
import { stripTrailingSlashes } from '../../util/trimEdges.js';

/** A non-streaming upstream call — defaults to callOpenAI; injectable for tests. */
export type RouterGatewayTransport = (
  llm: LLMConfig,
  messages: any[],
  tools: any[],
  options?: BuildPayloadOptions,
) => Promise<{ content: string; toolCalls?: any[]; usage?: any; finishReason?: string }>;

/** A streaming upstream call — defaults to callProviderStream; injectable for tests. */
export type RouterGatewayStreamTransport = (
  llm: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions,
) => AsyncIterable<StreamChunk>;

export interface RouterGatewayOptions {
  config: Config;
  host: string;
  port: number;
  /** Empty ⇒ keyless (loopback). When set, a matching Bearer is required. */
  serveKey?: string;
  transport?: RouterGatewayTransport;
  streamTransport?: RouterGatewayStreamTransport;
  maxAttempts?: number;
  /** Receives one secret-free final receipt for each completed routed call. */
  onRecoveryReceipt?: (receipt: ProviderRecoveryReceipt) => void;
  /**
   * ADR-061 D3.3/D5 — receives the route choice for each `auto` request that
   * the decision tier actually decided. A gateway is not a session, so it has
   * no `recent-decisions.json` to append to; its host logs this instead. Never
   * called while `cli.decisions.provider` is `rules`, because then the chain
   * head IS the answer and a line per request would say nothing.
   */
  onRouteDecision?: (entry: DecisionEntry) => void;
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
  opts: Pick<RouterGatewayOptions, 'streamTransport' | 'maxAttempts' | 'onRecoveryReceipt'>,
): Promise<void> {
  const policy = getRouterPolicy();
  const stream = opts.streamTransport ?? callProviderStream;
  const options = transportOptions(body);
  const includeUsage = body.stream_options?.include_usage === true;
  const id = newCompletionId();
  const created = nowSeconds();
  let headersSent = false;
  let activeModel = routes[0]?.model ?? 'router';

  try {
    await executeWithProviderRecovery({
      routes,
      policy,
      maxAttempts: opts.maxAttempts,
      onReceipt: opts.onRecoveryReceipt,
      execute: async (route) => {
        activeModel = route.model;
        try {
          // ADR-041 A41-5 — iterate the provider-neutral StreamChunk stream. Only
          // text deltas produce output frames here (as before); the terminal `done`
          // chunk carries the assembled result. Reasoning deltas are ignored, exactly
          // as the former onTextDelta-only handler ignored them — byte-neutral.
          let result: ProviderStreamResult | undefined;
          for await (const chunk of stream(route.llm, body.messages ?? [], body.tools ?? [], options)) {
            if (chunk.type === 'text') {
              const text = chunk.delta;
              if (!text) continue;
              if (!headersSent) {
                res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS_HEADERS });
                headersSent = true;
                res.write(chunkFrame(id, created, activeModel, { role: 'assistant', content: '' }, null));
              }
              res.write(chunkFrame(id, created, activeModel, { content: text }, null));
            } else if (chunk.type === 'done') {
              result = chunk.result;
            }
          }
          // The stream always terminates with a `done` chunk on success.
          const finalResult = result!;
          // Opening the response is the point of no return: after this, an
          // upstream failure must terminate this stream instead of changing
          // providers behind a partially delivered answer.
          if (!headersSent) {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS_HEADERS });
            headersSent = true;
            res.write(chunkFrame(id, created, activeModel, { role: 'assistant', content: '' }, null));
          }
          if (finalResult.toolCalls && finalResult.toolCalls.length) {
            res.write(chunkFrame(id, created, activeModel, { tool_calls: finalResult.toolCalls }, null));
          }
          res.write(chunkFrame(id, created, activeModel, {}, finishReasonFor(finalResult)));
          if (includeUsage && finalResult.usage) {
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: activeModel, choices: [], usage: finalResult.usage })}\n\n`);
          }
          res.end('data: [DONE]\n\n');
          return finalResult;
        } catch (error) {
          if (headersSent && error && (typeof error === 'object' || typeof error === 'function')) {
            (error as any).brainrouterStreamStarted = true;
          }
          if (headersSent && (error === null || (typeof error !== 'object' && typeof error !== 'function'))) {
            throw Object.assign(new Error(String(error)), { brainrouterStreamStarted: true });
          }
          throw error;
        }
      },
    });
  } catch (error) {
    if (headersSent) {
      // Mid-stream failure after output began — close cleanly with a stop frame.
      res.write(chunkFrame(id, created, activeModel, {}, 'stop'));
      res.end('data: [DONE]\n\n');
      return;
    }
    const msg = error instanceof Error ? error.message : String(error ?? 'No route available.');
    apiError(res, 502, msg, 'api_error');
  }
}

/**
 * ADR-061 D3.3 — re-head the chain for an `auto` request.
 *
 * Returns the resolved chain untouched on the default `rules` provider, before
 * spending a single character on redaction: the floor's answer is the chain's
 * own head, so asking would cost work to learn what we already have.
 */
async function startingRoutes(
  resolved: ModelRegistryEntry[],
  body: any,
  options: RouterGatewayOptions,
): Promise<ModelRegistryEntry[]> {
  const knobs = resolveCliKnobs(options.config).decisions;
  if (knobs.provider === 'rules') return resolved;
  try {
    const { port, maxStateChars } = decisionPortForSession({ knobs, config: options.config });
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
    const verdict = await chooseStartingRoute(
      port,
      resolved,
      {
        // D4 — the same redaction a transcript gets, before anything that can
        // leave this machine sees a caller's prompt.
        ...(typeof lastUser?.content === 'string' ? { task: redactText(lastUser.content) } : {}),
        approxPromptChars: messages.reduce((n, m) => n + messageChars(m), 0),
        ...(Array.isArray(body.tools) && body.tools.length > 0 ? { requiresTools: true } : {}),
      },
      { maxCandidates: knobs.route.maxCandidates, maxStateChars },
    );
    if (verdict.answer) {
      try {
        options.onRouteDecision?.(decisionEntry('route', 'start', verdict.answer, {
          outcome: verdict.changed ? `started on ${verdict.promoted}` : 'kept the configured head',
        }));
      } catch { /* reporting is best-effort */ }
    }
    return verdict.routes;
  } catch {
    // A decision must never cost a request. The configured chain still works.
    return resolved;
  }
}

/** How much text one message carries — the context-window signal, cheaply. */
function messageChars(message: any): number {
  const content = message?.content;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n: number, part: any) => n + (typeof part?.text === 'string' ? part.text.length : 0), 0);
  }
  return 0;
}

export function createRouterGatewayHandler(options: RouterGatewayOptions) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }
      // Accept both `/v1/...` (drop-in OpenAI base_url) and `/router/v1/...`.
      const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`);
      const path = stripTrailingSlashes(url.pathname.replace(/^\/router\/v1/, '/v1')) || '/';

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
        const resolved = resolveRoutes(registry, request, { withFallbacks: true });
        if (resolved.length === 0) {
          return apiError(res, 404, `The model \`${body.model ?? 'auto'}\` does not exist or is not routable.`, 'not_found_error', 'model_not_found', 'model');
        }
        // ADR-061 D3.3 — `auto` means "you pick", so the tier picks where to
        // START. An explicit model is the caller's own pick and never reaches
        // here. The chain itself is unchanged: same routes, same fallback
        // order behind whichever one is promoted.
        const routes = request === '' ? await startingRoutes(resolved, body, options) : resolved;
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
