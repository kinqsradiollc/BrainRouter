import type { Express, Request, Response as ExpressResponse } from 'express';

import {
  ModelEffortAdapterError,
  UpstreamPolicyError,
} from '@kinqs/brainrouter-core/provider';

import type { ProviderModelRecord } from '../../providers/modelPolicyStore.js';
import { resolveRequestUrl } from '../../providers/wireFormat.js';
import type { GatewayAuthContext } from './auth.js';
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

export interface GatewayDataPlaneOptions {
  timeoutMs?: number;
  upstream?: SafeUpstreamFetchOptions;
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
      phase = 'upstream';
      const upstream = await fetchUpstreamWithPolicy(
        resolveRequestUrl(resolved.provider.endpoint, 'chat-completions'),
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: lifetime.signal,
        },
        options.upstream,
      );
      if (!upstream.ok) {
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
      phase = 'upstream';
      const upstream = await fetchUpstreamWithPolicy(
        resolveRequestUrl(resolved.provider.endpoint, 'responses'),
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: lifetime.signal,
        },
        options.upstream,
      );
      if (!upstream.ok) {
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
      lifetime.cleanup();
      await finalizeAccounting(service, id, audit);
    }
  });
}
