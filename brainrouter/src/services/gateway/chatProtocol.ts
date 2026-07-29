import {
  applyModelEffortWireMap,
  type ModelEffortWireMap,
} from '@kinqs/brainrouter-core/provider';

import type { GatewayResolvedModel } from './modelPolicy.js';
import { chatTokenUsage, type GatewayTokenUsage } from './usage.js';

const SUPPORTED_CHAT_FIELDS = new Set([
  'audio',
  'frequency_penalty',
  'function_call',
  'functions',
  'logit_bias',
  'logprobs',
  'max_completion_tokens',
  'max_tokens',
  'messages',
  'metadata',
  'modalities',
  'model',
  'n',
  'parallel_tool_calls',
  'prediction',
  'presence_penalty',
  'reasoning',
  'reasoning_effort',
  'response_format',
  'seed',
  'service_tier',
  'stop',
  'store',
  'stream',
  'stream_options',
  'temperature',
  'tool_choice',
  'tools',
  'top_logprobs',
  'top_p',
  'user',
  'verbosity',
  'web_search_options',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class GatewayRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly param: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayRequestError';
  }
}

export class GatewayUpstreamProtocolError extends Error {
  constructor(message = 'The upstream provider returned an invalid response.') {
    super(message);
    this.name = 'GatewayUpstreamProtocolError';
  }
}

export interface ParsedChatRequest {
  body: Record<string, unknown>;
  model: string;
  effort: unknown;
  stream: boolean;
  usesTools: boolean;
}

type GatewayEffortEndpoint = 'chat' | 'responses';

/**
 * Select the exact persisted target for one OpenAI-compatible endpoint. A map
 * may contain both native fields so the same public model works through Chat
 * and Responses. For legacy single-field maps, only the endpoint-defined path
 * is translated; the exact persisted value is preserved and never collapsed.
 */
export function endpointEffortWireMap(
  resolved: GatewayResolvedModel,
  endpoint: GatewayEffortEndpoint,
): ModelEffortWireMap {
  const effort = resolved.selectedEffort;
  if (effort === null) return {};
  const targets = resolved.model.effortWireMap[effort];
  if (!targets) return resolved.model.effortWireMap as ModelEffortWireMap;

  const chatPath = 'reasoning_effort';
  const responsesPath = 'reasoning.effort';
  const hasEndpointSpecificPath = Object.hasOwn(targets, chatPath)
    || Object.hasOwn(targets, responsesPath);
  if (!hasEndpointSpecificPath) {
    return resolved.model.effortWireMap as ModelEffortWireMap;
  }

  const requiredPath = endpoint === 'chat' ? chatPath : responsesPath;
  const excludedPath = endpoint === 'chat' ? responsesPath : chatPath;
  const exactValue = Object.hasOwn(targets, requiredPath)
    ? targets[requiredPath]
    : targets[excludedPath];
  return {
    [effort]: {
      ...Object.fromEntries(
        Object.entries(targets).filter(([path]) => path !== chatPath && path !== responsesPath),
      ),
      [requiredPath]: exactValue,
    },
  };
}

/** Validate the supported OpenAI Chat surface without silently dropping fields. */
export function parseChatRequest(value: unknown): ParsedChatRequest {
  if (!isRecord(value)) {
    throw new GatewayRequestError('invalid_request', null, 'The request body must be a JSON object.');
  }
  const unsupported = Object.keys(value).find((key) => !SUPPORTED_CHAT_FIELDS.has(key));
  if (unsupported) {
    throw new GatewayRequestError(
      'unsupported_parameter',
      unsupported,
      `Unsupported parameter: ${unsupported}.`,
    );
  }

  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!model) {
    throw new GatewayRequestError('invalid_model', 'model', 'A model is required.');
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new GatewayRequestError('invalid_messages', 'messages', 'At least one message is required.');
  }
  for (const message of value.messages) {
    if (!isRecord(message) || typeof message.role !== 'string' || !message.role.trim()) {
      throw new GatewayRequestError('invalid_messages', 'messages', 'Every message requires a role.');
    }
  }
  if (value.stream !== undefined && typeof value.stream !== 'boolean') {
    throw new GatewayRequestError('invalid_stream', 'stream', 'stream must be a boolean.');
  }
  if (value.tools !== undefined && !Array.isArray(value.tools)) {
    throw new GatewayRequestError('invalid_tools', 'tools', 'tools must be an array.');
  }
  if (value.functions !== undefined && !Array.isArray(value.functions)) {
    throw new GatewayRequestError('invalid_tools', 'functions', 'functions must be an array.');
  }
  const stream = value.stream === true;
  if (value.stream_options !== undefined && !stream) {
    throw new GatewayRequestError(
      'invalid_stream_options',
      'stream_options',
      'stream_options requires stream=true.',
    );
  }

  let nestedEffort: unknown;
  if (value.reasoning !== undefined) {
    if (!isRecord(value.reasoning)) {
      throw new GatewayRequestError('invalid_reasoning_effort', 'reasoning', 'reasoning must be an object.');
    }
    const unsupportedReasoning = Object.keys(value.reasoning).find((key) => key !== 'effort');
    if (unsupportedReasoning || !Object.hasOwn(value.reasoning, 'effort')) {
      throw new GatewayRequestError(
        'unsupported_parameter',
        unsupportedReasoning ? `reasoning.${unsupportedReasoning}` : 'reasoning',
        'Only reasoning.effort is supported.',
      );
    }
    nestedEffort = value.reasoning.effort;
  }
  if (
    value.reasoning_effort !== undefined
    && nestedEffort !== undefined
    && value.reasoning_effort !== nestedEffort
  ) {
    throw new GatewayRequestError(
      'invalid_reasoning_effort',
      'reasoning_effort',
      'reasoning_effort and reasoning.effort must match when both are supplied.',
    );
  }

  return {
    body: value,
    model,
    effort: value.reasoning_effort ?? nestedEffort,
    stream,
    usesTools: (Array.isArray(value.tools) && value.tools.length > 0)
      || (Array.isArray(value.functions) && value.functions.length > 0),
  };
}

/** Replace only server-owned routing fields and apply the exact persisted adapter. */
export function buildUpstreamChatPayload(
  request: ParsedChatRequest,
  resolved: GatewayResolvedModel,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...request.body };
  delete payload.reasoning_effort;
  delete payload.reasoning;
  payload.model = resolved.model.upstreamModelId;

  if (resolved.selectedEffort === null) return payload;
  return applyModelEffortWireMap(
    payload,
    resolved.selectedEffort,
    endpointEffortWireMap(resolved, 'chat'),
  );
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Read a bounded JSON response while honoring cancellation after headers. */
export async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  maxBytes = 16 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  if (!response.body) throw new GatewayUpstreamProtocolError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  let exhausted = false;
  try {
    while (true) {
      const chunk = await readWithAbort(reader, signal);
      if (chunk.done) {
        exhausted = true;
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new GatewayUpstreamProtocolError();
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (!exhausted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GatewayUpstreamProtocolError();
  }
  if (!isRecord(parsed) || parsed.error !== undefined || !Array.isArray(parsed.choices)) {
    throw new GatewayUpstreamProtocolError();
  }
  return parsed;
}

/** Keep the public model ID while preserving choices, tool calls, and usage. */
export function normalizeChatCompletion(
  response: Record<string, unknown>,
  publicModelId: string,
): Record<string, unknown> {
  return { ...response, model: publicModelId };
}

export interface NormalizedSseEvent {
  text: string;
  done: boolean;
  usage: GatewayTokenUsage | null;
}

/** Normalize one OpenAI SSE event without exposing the upstream model ID. */
export function normalizeChatSseEvent(
  event: string,
  publicModelId: string,
): NormalizedSseEvent {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!data) return { text: '', done: false, usage: null };
  if (data === '[DONE]') return { text: 'data: [DONE]\n\n', done: true, usage: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new GatewayUpstreamProtocolError();
  }
  if (!isRecord(parsed) || parsed.error !== undefined || !Array.isArray(parsed.choices)) {
    throw new GatewayUpstreamProtocolError();
  }
  return {
    text: `data: ${JSON.stringify({ ...parsed, model: publicModelId })}\n\n`,
    done: false,
    usage: chatTokenUsage(parsed.usage),
  };
}

export { readWithAbort };
