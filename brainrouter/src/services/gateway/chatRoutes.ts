import type { Express, Request, Response as ExpressResponse } from 'express';

import {
  findProviderByEndpoint,
  ModelEffortAdapterError,
  UpstreamPolicyError,
} from '@kinqs/brainrouter-core/provider';

import type { ProviderModelRecord } from '../../providers/modelPolicyStore.js';
import { resolveRequestUrl } from '../../providers/wireFormat.js';
import type { ResolvedProviderConfig } from '../../providers/types.js';
import type { GatewayAuthContext } from './auth.js';
import { selectEdgeDialer, type EgressMode } from './egress/edgeDialerSelection.js';
import type { EgressTunnelTransport } from './egress/tunnelTransport.js';
import {
  GatewayQuotaError,
  type GatewayUsageEvent,
} from './accounting.js';
import {
  buildUpstreamChatPayload,
  GatewayRequestError,
  GatewayUpstreamProtocolError,
  normalizeChatCompletion,
  normalizeChatSseEvent,
  parseChatRequest,
  readBoundedJson,
  readWithAbort,
} from './chatProtocol.js';
import {
  GatewayModelPolicyError,
  type GatewayResolvedModel,
} from './modelPolicy.js';
import {
  fetchUpstreamWithPolicy,
  type SafeUpstreamFetchOptions,
} from './upstreamPolicy.js';
import {
  buildUpstreamResponsesPayload,
  normalizeResponseObject,
  normalizeResponsesSseEvent,
  parseResponsesRequest,
  readBoundedResponsesJson,
} from './responsesProtocol.js';
import {
  chatTokenUsage,
  responsesTokenUsage,
  type GatewayTokenUsage,
} from './usage.js';
import { RateShaper, type AcquireResult } from './rateShaper.js';

// ADR-043 S1 (D5) — the gateway rate-shaper. Records an upstream 429's
// Retry-After so a burst stops hammering a key the provider already refused (the
// review-bot free-tier wedge), and fast-fails requests to a parked key with the
// hint. S1b additionally reserves a per-key slot before each dial so the
// concurrency cap + rpm budget shape a burst BEFORE it stampedes the upstream.
// Generous per-key budgets: they only shape extreme bursts. Fail-open — a key
// with no state, and traffic under the budgets, is admitted with zero added latency.
// Generous per-key defaults: they only shape extreme bursts. Overridable via
// GatewayDataPlaneOptions.rateShaper (ops tuning + deterministic tests).
const DEFAULT_SHAPER_BUDGET = { maxConcurrentPerKey: 64, rpmPerKey: 600, maxQueuePerKey: 256 } as const;
const shaperKeyFor = (orgId: string, endpoint: string): string => `${orgId}\u0000${endpoint}`;
function shaperFastFail(shaper: RateShaper, res: ExpressResponse, key: string): boolean {
  const parkedMs = shaper.parkedFor(key);
  if (parkedMs <= 0) return false;
  res.setHeader('retry-after', String(Math.ceil(parkedMs / 1000)));
  sendOpenAiError(res, 429, {
    message: 'The upstream provider is rate limited; retry after the indicated delay.',
    type: 'rate_limit_error',
    param: null,
    code: 'upstream_rate_limited',
  });
  return true;
}
function shaperNoteUpstream429(shaper: RateShaper, key: string, upstream: Response): void {
  const retryAfter = upstream.headers.get('retry-after');
  const seconds = retryAfter && /^\d{1,6}$/.test(retryAfter) ? Number(retryAfter) : 5;
  shaper.noteRetryAfter(key, seconds);
}
// ADR-043 S1b (D5) — proactive shaping: reserve a per-key slot before dialing so a
// burst is bounded by the concurrency cap + rpm budget BEFORE it stampedes an
// upstream (not only reactively after a 429 parks the key). Budgets are generous
// and fail-open — a key under them is admitted with zero added latency. Returns a
// one-shot `release` the caller MUST invoke in its finally, or null after sending
// the 429 (concurrency / rpm / queue-full / a raced Retry-After park).
function shaperAcquire(shaper: RateShaper, res: ExpressResponse, key: string): (() => void) | null {
  const result: AcquireResult = shaper.tryAcquire(key);
  if (result.ok) return result.release;
  res.setHeader('retry-after', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
  sendOpenAiError(res, 429, {
    message: 'This tenant is sending requests faster than the per-key budget; retry after the indicated delay.',
    type: 'rate_limit_error',
    param: null,
    code: `gateway_${result.reason}`,
  });
  return null;
}

export interface GatewayDataPlaneService {
  listModels(auth: GatewayAuthContext): Promise<ProviderModelRecord[]>;
  resolveModel(
    auth: GatewayAuthContext,
    publicModelId: string,
    reasoningEffort?: unknown,
  ): Promise<GatewayResolvedModel>;
  acquireRequest(auth: GatewayAuthContext, requestId: string, leaseMs: number): Promise<void>;
  releaseRequest(orgId: string, requestId: string): Promise<void>;
  recordUsage(event: GatewayUsageEvent): Promise<void>;
}

/**
 * ADR-043 S3b (C6b) — the per-request egress selection inputs. When present (the
 * tunnel is enabled at boot), the route MAY route a dial through the requesting
 * user's own device; when absent, every dial uses direct server egress exactly
 * as before.
 */
export interface GatewayEgressSelection {
  /** A live tunnel transport for this account, or undefined when no device is online. */
  transportForAccount(orgId: string, userId: string, upstreamKeyId: string): EgressTunnelTransport | undefined;
  /** Per-org consent gate (D2). Read only on the rare tunnel-eligible path. */
  orgOptIn(orgId: string): Promise<boolean>;
  /** Fired once per connection that drops from tunnel to server egress (telemetry). */
  onFallback?: (reason: Error) => void;
}

export interface GatewayDataPlaneOptions {
  timeoutMs?: number;
  /** ADR-043 S1 — override the per-key rate-shaper budgets (defaults in DEFAULT_SHAPER_BUDGET). */
  rateShaper?: Partial<{ maxConcurrentPerKey: number; rpmPerKey: number; maxQueuePerKey: number }>;
  upstream?: SafeUpstreamFetchOptions;
  /** ADR-043 S3b (C6b) — edge-egress selection; omitted ⇒ tunnel off ⇒ direct egress. */
  egress?: GatewayEgressSelection;
}

/**
 * ADR-043 S3b (C6b) — resolve the upstream fetch options for ONE dial, choosing
 * the edge-tunnel dispatcher only when it is genuinely eligible: the tunnel is
 * enabled, the caller is a user (services have no device), the provider adapter
 * declares `clientTunnel` in a tunnelling mode, that user has an online device,
 * AND the org has opted in. On the common path this is a couple of cheap checks
 * and returns the shared `options.upstream` unchanged (never mutated). The
 * per-org consent DB read happens ONLY on the otherwise-eligible path.
 */
/** The provider egress fields the selection reads; injected for tests. */
type ProviderEgressLookup = (
  endpoint: string,
) => { egressMode?: EgressMode; egressCapabilities?: { vendableToken?: boolean; clientTunnel?: boolean } } | undefined;

export async function selectUpstreamForRequest(
  options: GatewayDataPlaneOptions,
  auth: GatewayAuthContext,
  provider: ResolvedProviderConfig,
  lookupEgress: ProviderEgressLookup = findProviderByEndpoint,
): Promise<SafeUpstreamFetchOptions | undefined> {
  const base = options.upstream;
  const egress = options.egress;
  if (!egress || auth.principalType !== 'user') return base;
  try {
    const def = lookupEgress(provider.endpoint);
    const mode = def?.egressMode;
    if (!def?.egressCapabilities?.clientTunnel || (mode !== 'client-tunnel' && mode !== 'auto')) return base;
    const transport = egress.transportForAccount(auth.orgId, auth.userId, provider.endpoint);
    if (!transport) return base;
    if (!(await egress.orgOptIn(auth.orgId))) return base;
    const dispatcherFactory = selectEdgeDialer({
      egressMode: mode,
      egressCapabilities: def.egressCapabilities,
      transport,
      orgOptIn: true,
      onFallback: egress.onFallback,
    });
    return { ...base, dispatcherFactory };
  } catch (err) {
    // The tunnel must NEVER fail a request. Any error while selecting it — a
    // transient consent-read DB error, a provider lookup, a transport build —
    // falls back to direct server egress (the behaviour before this feature).
    egress.onFallback?.(err instanceof Error ? err : new Error(String(err)));
    return base;
  }
}

interface OpenAiErrorBody {
  message: string;
  type: string;
  param: string | null;
  code: string | null;
}

export function sendOpenAiError(
  res: ExpressResponse,
  status: number,
  error: OpenAiErrorBody,
): void {
  res.status(status).json({ error });
}

function authContext(res: ExpressResponse): GatewayAuthContext {
  return res.locals.gatewayAuth as GatewayAuthContext;
}

function requestId(res: ExpressResponse): string {
  return typeof res.locals.requestId === 'string' ? res.locals.requestId : 'req_unknown';
}

function createdSeconds(value: string): number {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : 0;
}

function timeoutDuration(value: number | undefined): number {
  return Number.isFinite(value) && Number.isInteger(value) && value! > 0 && value! <= 300_000
    ? value!
    : 120_000;
}

interface GatewayAuditState {
  auth: GatewayAuthContext;
  resolved: GatewayResolvedModel;
  startedAt: number;
  status: number;
  usage: GatewayTokenUsage | null;
  permitAcquired: boolean;
  /** ADR-043 C7 (D4) — the egress path taken: 'server' (default) or 'client-tunnel'. */
  egressMode: string;
}

function usageEvent(
  id: string,
  audit: GatewayAuditState,
): GatewayUsageEvent {
  return {
    requestId: id,
    orgId: audit.auth.orgId,
    userId: audit.auth.principalType === 'user' ? audit.auth.userId : null,
    servicePrincipalId: audit.auth.principalType === 'service'
      ? audit.auth.servicePrincipalId
      : null,
    publicModelId: audit.resolved.model.publicModelId,
    selectedEffort: audit.resolved.selectedEffort,
    // A provider configuration id is sufficient for internal routing analysis;
    // endpoint URLs can contain query credentials and are deliberately excluded.
    upstreamRoute: `provider:${audit.resolved.model.providerConfigId}`,
    latencyMs: Math.max(0, Date.now() - audit.startedAt),
    httpStatus: audit.status,
    usage: audit.usage,
    costMicrousd: null,
    egressMode: audit.egressMode,
  };
}

async function finalizeAccounting(
  service: GatewayDataPlaneService,
  id: string,
  audit: GatewayAuditState | null,
): Promise<void> {
  if (!audit) return;
  if (audit.permitAcquired) {
    try {
      await service.releaseRequest(audit.auth.orgId, id);
    } catch {
      console.error(`[provider-gateway] failed to release request permit ${id}`);
    }
  }
  try {
    await service.recordUsage(usageEvent(id, audit));
  } catch {
    console.error(`[provider-gateway] failed to record usage event ${id}`);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function requestLifetime(req: Request, res: ExpressResponse, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  let clientClosed = false;
  const onTimeout = (): void => {
    timedOut = true;
    controller.abort(new DOMException('The upstream request timed out.', 'TimeoutError'));
  };
  const onClientClose = (): void => {
    if (res.writableEnded) return;
    clientClosed = true;
    controller.abort(new DOMException('The downstream client disconnected.', 'AbortError'));
  };
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref?.();
  req.once('aborted', onClientClose);
  res.once('close', onClientClose);
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    get clientClosed() { return clientClosed; },
    cleanup(): void {
      clearTimeout(timer);
      req.off('aborted', onClientClose);
      res.off('close', onClientClose);
    },
  };
}

async function writeWithBackpressure(
  res: ExpressResponse,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  if (!text || res.write(text)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); reject(new Error('Downstream client disconnected.')); };
    const onAbort = (): void => { cleanup(); reject(abortError(signal)); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function forwardChatSse(
  upstream: Response,
  res: ExpressResponse,
  publicModelId: string,
  signal: AbortSignal,
): Promise<GatewayTokenUsage | null> {
  if (!upstream.body || !/^text\/event-stream\b/i.test(upstream.headers.get('content-type') ?? '')) {
    throw new GatewayUpstreamProtocolError();
  }
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneEvent = false;
  let usage: GatewayTokenUsage | null = null;

  const drainEvents = async (final = false): Promise<void> => {
    while (true) {
      const separator = buffer.match(/\r?\n\r?\n/);
      if (!separator || separator.index === undefined) break;
      const event = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const normalized = normalizeChatSseEvent(event, publicModelId);
      usage = normalized.usage ?? usage;
      await writeWithBackpressure(res, normalized.text, signal);
      if (normalized.done) {
        doneEvent = true;
        return;
      }
    }
    if (final && buffer.trim()) {
      const normalized = normalizeChatSseEvent(buffer, publicModelId);
      usage = normalized.usage ?? usage;
      buffer = '';
      await writeWithBackpressure(res, normalized.text, signal);
      doneEvent = normalized.done;
    }
    if (buffer.length > 1_048_576) throw new GatewayUpstreamProtocolError();
  };

  try {
    while (!doneEvent) {
      const chunk = await readWithAbort(reader, signal);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      await drainEvents();
    }
    buffer += decoder.decode();
    if (!doneEvent) await drainEvents(true);
    if (!doneEvent) await writeWithBackpressure(res, 'data: [DONE]\n\n', signal);
    res.end();
    return usage;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function forwardResponsesSse(
  upstream: Response,
  res: ExpressResponse,
  publicModelId: string,
  signal: AbortSignal,
): Promise<{ usage: GatewayTokenUsage | null; httpStatus: 200 | 502 }> {
  if (!upstream.body || !/^text\/event-stream\b/i.test(upstream.headers.get('content-type') ?? '')) {
    throw new GatewayUpstreamProtocolError();
  }
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminalEvent = false;
  let failed = false;
  let usage: GatewayTokenUsage | null = null;

  const drainEvents = async (final = false): Promise<void> => {
    while (true) {
      const separator = buffer.match(/\r?\n\r?\n/);
      if (!separator || separator.index === undefined) break;
      const event = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const normalized = normalizeResponsesSseEvent(event, publicModelId);
      usage = normalized.usage ?? usage;
      failed = failed || normalized.failed;
      await writeWithBackpressure(res, normalized.text, signal);
      if (normalized.done) {
        terminalEvent = true;
        return;
      }
    }
    if (final && buffer.trim()) {
      const normalized = normalizeResponsesSseEvent(buffer, publicModelId);
      buffer = '';
      usage = normalized.usage ?? usage;
      failed = failed || normalized.failed;
      await writeWithBackpressure(res, normalized.text, signal);
      terminalEvent = terminalEvent || normalized.done;
    }
    if (buffer.length > 1_048_576) throw new GatewayUpstreamProtocolError();
  };

  try {
    while (!terminalEvent) {
      const chunk = await readWithAbort(reader, signal);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      await drainEvents();
    }
    buffer += decoder.decode();
    if (!terminalEvent) await drainEvents(true);
    if (!terminalEvent) throw new GatewayUpstreamProtocolError();
    res.end();
    return { usage, httpStatus: failed ? 502 : 200 };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function sendUpstreamError(res: ExpressResponse, upstream: Response): Promise<number> {
  await upstream.body?.cancel().catch(() => undefined);
  if (upstream.status === 429) {
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter && /^\d{1,6}$/.test(retryAfter)) res.setHeader('retry-after', retryAfter);
    sendOpenAiError(res, 429, {
      message: 'The upstream provider is rate limited.',
      type: 'rate_limit_error',
      param: null,
      code: 'upstream_rate_limited',
    });
    return 429;
  }
  if (upstream.status === 408 || upstream.status === 504) {
    sendOpenAiError(res, 504, {
      message: 'The upstream model request timed out.',
      type: 'timeout_error',
      param: null,
      code: 'upstream_timeout',
    });
    return 504;
  }
  if ([400, 404, 409, 413, 422].includes(upstream.status)) {
    sendOpenAiError(res, 400, {
      message: 'The upstream provider rejected the request.',
      type: 'invalid_request_error',
      param: null,
      code: 'upstream_invalid_request',
    });
    return 400;
  }
  sendOpenAiError(res, 502, {
    message: 'The upstream provider could not complete the request.',
    type: 'api_error',
    param: null,
    code: upstream.status === 401 || upstream.status === 403
      ? 'upstream_authentication_error'
      : 'upstream_error',
  });
  return 502;
}

function sendCaughtError(
  res: ExpressResponse,
  error: unknown,
  phase: 'policy' | 'upstream',
): number {
  if (error instanceof GatewayQuotaError) {
    res.setHeader('retry-after', String(error.retryAfterSeconds));
    sendOpenAiError(res, 429, {
      message: error.message,
      type: 'rate_limit_error',
      param: null,
      code: error.code,
    });
    return 429;
  }
  if (error instanceof GatewayRequestError) {
    sendOpenAiError(res, 400, {
      message: error.message,
      type: 'invalid_request_error',
      param: error.param,
      code: error.code,
    });
    return 400;
  }
  if (error instanceof GatewayModelPolicyError) {
    sendOpenAiError(res, error.status, {
      message: error.message,
      type: error.status === 503 ? 'api_error' : 'invalid_request_error',
      param: error.code === 'invalid_reasoning_effort' ? 'reasoning_effort' : 'model',
      code: error.code,
    });
    return error.status;
  }
  if (error instanceof ModelEffortAdapterError) {
    sendOpenAiError(res, 502, {
      message: 'The model provider is not configured correctly.',
      type: 'api_error',
      param: null,
      code: 'model_configuration_error',
    });
    return 502;
  }
  if (error instanceof UpstreamPolicyError) {
    sendOpenAiError(res, 502, {
      message: 'The model provider is not available.',
      type: 'api_error',
      param: null,
      code: 'upstream_configuration_error',
    });
    return 502;
  }
  if (error instanceof GatewayUpstreamProtocolError) {
    sendOpenAiError(res, 502, {
      message: 'The upstream provider returned an invalid response.',
      type: 'api_error',
      param: null,
      code: 'upstream_response_error',
    });
    return 502;
  }
  sendOpenAiError(res, phase === 'upstream' ? 502 : 500, {
    message: phase === 'upstream'
      ? 'The upstream provider could not complete the request.'
      : 'BrainRouter could not complete the request.',
    type: 'api_error',
    param: null,
    code: phase === 'upstream' ? 'upstream_unavailable' : 'internal_error',
  });
  return phase === 'upstream' ? 502 : 500;
}

export function registerGatewayDataPlane(
  app: Express,
  service: GatewayDataPlaneService,
  options: GatewayDataPlaneOptions = {},
): void {
  // ADR-043 S1 — one shaper instance per data-plane registration, keyed per
  // org+endpoint. Budgets default to DEFAULT_SHAPER_BUDGET; tests/ops override.
  const shaper = new RateShaper({ ...DEFAULT_SHAPER_BUDGET, ...options.rateShaper });
  app.get('/v1/models', async (_req: Request, res: ExpressResponse) => {
    try {
      const models = await service.listModels(authContext(res));
      res.setHeader('cache-control', 'private, no-store');
      res.json({
        object: 'list',
        data: models.filter((model) => model.enabled).map((model) => ({
          id: model.publicModelId,
          object: 'model',
          created: createdSeconds(model.createdAt),
          owned_by: 'brainrouter',
        })),
      });
    } catch {
      sendOpenAiError(res, 500, {
        message: 'BrainRouter could not list models.',
        type: 'api_error',
        param: null,
        code: 'internal_error',
      });
    }
  });

  app.post('/v1/chat/completions', async (req: Request, res: ExpressResponse) => {
    const startedAt = Date.now();
    const timeoutMs = timeoutDuration(options.timeoutMs);
    const lifetime = requestLifetime(req, res, timeoutMs);
    const id = requestId(res);
    let phase: 'policy' | 'upstream' = 'policy';
    let audit: GatewayAuditState | null = null;
    // ADR-043 S1b — a reserved shaper slot, released in `finally` on every exit path.
    let releaseShaperSlot: (() => void) | null = null;
    try {
      const parsed = parseChatRequest(req.body);
      const auth = authContext(res);
      const resolved = await service.resolveModel(auth, parsed.model, parsed.effort);
      audit = {
        auth,
        resolved,
        startedAt,
        status: 500,
        usage: null,
        permitAcquired: false,
        egressMode: 'server',
      };
      if (parsed.stream && !resolved.model.capabilities.streaming) {
        throw new GatewayRequestError(
          'unsupported_model_capability',
          'stream',
          `Streaming is not enabled for ${resolved.model.publicModelId}.`,
        );
      }
      if (parsed.usesTools && !resolved.model.capabilities.tools) {
        throw new GatewayRequestError(
          'unsupported_model_capability',
          'tools',
          `Tools are not enabled for ${resolved.model.publicModelId}.`,
        );
      }
      await service.acquireRequest(auth, id, timeoutMs + 30_000);
      audit.permitAcquired = true;

      const body = buildUpstreamChatPayload(parsed, resolved);
      const headers = new Headers({
        accept: parsed.stream ? 'text/event-stream' : 'application/json',
        'content-type': 'application/json',
        'x-request-id': id,
      });
      if (resolved.provider.apiKey) {
        headers.set('authorization', `Bearer ${resolved.provider.apiKey}`);
      }
      // ADR-043 S1 — if this org+endpoint key is parked by a prior upstream
      // Retry-After, fail fast with the hint instead of hammering it.
      const shaperKey = shaperKeyFor(audit.auth.orgId, resolved.provider.endpoint);
      if (shaperFastFail(shaper, res, shaperKey)) { audit.status = 429; return; }
      releaseShaperSlot = shaperAcquire(shaper, res, shaperKey);
      if (!releaseShaperSlot) { audit.status = 429; return; }
      phase = 'upstream';
      const upstreamOptions = await selectUpstreamForRequest(options, audit.auth, resolved.provider);
      // A fresh options object (not the shared base) means the edge tunnel engaged.
      audit.egressMode = upstreamOptions !== options.upstream ? 'client-tunnel' : 'server';
      const upstream = await fetchUpstreamWithPolicy(
        resolveRequestUrl(resolved.provider.endpoint, 'chat-completions'),
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: lifetime.signal,
        },
        upstreamOptions,
      );
      if (!upstream.ok) {
        if (upstream.status === 429) shaperNoteUpstream429(shaper, shaperKey, upstream);
        audit.status = await sendUpstreamError(res, upstream);
        return;
      }
      if (parsed.stream) {
        audit.usage = await forwardChatSse(
          upstream,
          res,
          resolved.model.publicModelId,
          lifetime.signal,
        );
        audit.status = 200;
        return;
      }
      const response = await readBoundedJson(upstream, lifetime.signal);
      audit.usage = chatTokenUsage(response.usage);
      audit.status = 200;
      res.json(normalizeChatCompletion(response, resolved.model.publicModelId));
    } catch (error) {
      if (lifetime.clientClosed || res.destroyed) {
        if (audit) audit.status = 499;
        return;
      }
      if (lifetime.timedOut) {
        if (audit) audit.status = 504;
        if (res.headersSent) res.destroy();
        else {
          sendOpenAiError(res, 504, {
            message: 'The upstream model request timed out.',
            type: 'timeout_error',
            param: null,
            code: 'upstream_timeout',
          });
        }
        return;
      }
      if (res.headersSent) {
        if (audit) audit.status = 502;
        res.destroy();
        return;
      }
      const status = sendCaughtError(res, error, phase);
      if (audit) audit.status = status;
    } finally {
      if (releaseShaperSlot) releaseShaperSlot();
      lifetime.cleanup();
      await finalizeAccounting(service, id, audit);
    }
  });

  app.post('/v1/responses', async (req: Request, res: ExpressResponse) => {
    const startedAt = Date.now();
    const timeoutMs = timeoutDuration(options.timeoutMs);
    const lifetime = requestLifetime(req, res, timeoutMs);
    const id = requestId(res);
    let phase: 'policy' | 'upstream' = 'policy';
    let audit: GatewayAuditState | null = null;
    // ADR-043 S1b — a reserved shaper slot, released in `finally` on every exit path.
    let releaseShaperSlot: (() => void) | null = null;
    try {
      const parsed = parseResponsesRequest(req.body);
      const auth = authContext(res);
      const resolved = await service.resolveModel(auth, parsed.model, parsed.effort);
      audit = {
        auth,
        resolved,
        startedAt,
        status: 500,
        usage: null,
        permitAcquired: false,
        egressMode: 'server',
      };
      if (!resolved.model.capabilities.responses) {
        throw new GatewayRequestError(
          'unsupported_model_capability',
          'model',
          `Responses are not enabled for ${resolved.model.publicModelId}.`,
        );
      }
      if (parsed.stream && !resolved.model.capabilities.streaming) {
        throw new GatewayRequestError(
          'unsupported_model_capability',
          'stream',
          `Streaming is not enabled for ${resolved.model.publicModelId}.`,
        );
      }
      if (parsed.usesTools && !resolved.model.capabilities.tools) {
        throw new GatewayRequestError(
          'unsupported_model_capability',
          'tools',
          `Tools are not enabled for ${resolved.model.publicModelId}.`,
        );
      }
      await service.acquireRequest(auth, id, timeoutMs + 30_000);
      audit.permitAcquired = true;

      const body = buildUpstreamResponsesPayload(parsed, resolved);
      const headers = new Headers({
        accept: parsed.stream ? 'text/event-stream' : 'application/json',
        'content-type': 'application/json',
        'x-request-id': id,
      });
      if (resolved.provider.apiKey) {
        headers.set('authorization', `Bearer ${resolved.provider.apiKey}`);
      }
      // ADR-043 S1 — if this org+endpoint key is parked by a prior upstream
      // Retry-After, fail fast with the hint instead of hammering it.
      const shaperKey = shaperKeyFor(audit.auth.orgId, resolved.provider.endpoint);
      if (shaperFastFail(shaper, res, shaperKey)) { audit.status = 429; return; }
      releaseShaperSlot = shaperAcquire(shaper, res, shaperKey);
      if (!releaseShaperSlot) { audit.status = 429; return; }
      phase = 'upstream';
      const upstreamOptions = await selectUpstreamForRequest(options, audit.auth, resolved.provider);
      // A fresh options object (not the shared base) means the edge tunnel engaged.
      audit.egressMode = upstreamOptions !== options.upstream ? 'client-tunnel' : 'server';
      const upstream = await fetchUpstreamWithPolicy(
        resolveRequestUrl(resolved.provider.endpoint, 'responses'),
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: lifetime.signal,
        },
        upstreamOptions,
      );
      if (!upstream.ok) {
        if (upstream.status === 429) shaperNoteUpstream429(shaper, shaperKey, upstream);
        audit.status = await sendUpstreamError(res, upstream);
        return;
      }
      if (parsed.stream) {
        const streamed = await forwardResponsesSse(
          upstream,
          res,
          resolved.model.publicModelId,
          lifetime.signal,
        );
        audit.usage = streamed.usage;
        audit.status = streamed.httpStatus;
        return;
      }
      const response = await readBoundedResponsesJson(upstream, lifetime.signal);
      audit.usage = responsesTokenUsage(response.usage);
      audit.status = 200;
      res.json(normalizeResponseObject(response, resolved.model.publicModelId));
    } catch (error) {
      if (lifetime.clientClosed || res.destroyed) {
        if (audit) audit.status = 499;
        return;
      }
      if (lifetime.timedOut) {
        if (audit) audit.status = 504;
        if (res.headersSent) res.destroy();
        else {
          sendOpenAiError(res, 504, {
            message: 'The upstream model request timed out.',
            type: 'timeout_error',
            param: null,
            code: 'upstream_timeout',
          });
        }
        return;
      }
      if (res.headersSent) {
        if (audit) audit.status = 502;
        res.destroy();
        return;
      }
      const status = sendCaughtError(res, error, phase);
      if (audit) audit.status = status;
    } finally {
      if (releaseShaperSlot) releaseShaperSlot();
      lifetime.cleanup();
      await finalizeAccounting(service, id, audit);
    }
  });
}
