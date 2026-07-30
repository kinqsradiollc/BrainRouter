import {
  applyModelEffortWireMap,
} from '@kinqs/brainrouter-core/provider';

import type { GatewayResolvedModel } from './modelPolicy.js';
import {
  GatewayRequestError,
  GatewayUpstreamProtocolError,
  endpointEffortWireMap,
  readWithAbort,
} from './chatProtocol.js';
import { responsesTokenUsage, type GatewayTokenUsage } from './usage.js';

const SUPPORTED_RESPONSES_FIELDS = new Set([
  'conversation',
  'include',
  'input',
  'instructions',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'model',
  'parallel_tool_calls',
  'previous_response_id',
  'prompt',
  'prompt_cache_key',
  'prompt_cache_retention',
  'reasoning',
  'reasoning_effort',
  'safety_identifier',
  'service_tier',
  'store',
  'stream',
  'temperature',
  'text',
  'tool_choice',
  'tools',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
]);

const SUPPORTED_REASONING_FIELDS = new Set(['effort', 'summary', 'generate_summary']);
const RESPONSES_EVENT_TYPE = /^response\.[a-z0-9_.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface ParsedResponsesRequest {
  body: Record<string, unknown>;
  model: string;
  effort: unknown;
  stream: boolean;
  usesTools: boolean;
}

/** Validate the supported OpenAI Responses surface without dropping fields. */
export function parseResponsesRequest(value: unknown): ParsedResponsesRequest {
  if (!isRecord(value)) {
    throw new GatewayRequestError('invalid_request', null, 'The request body must be a JSON object.');
  }
  const unsupported = Object.keys(value).find((key) => !SUPPORTED_RESPONSES_FIELDS.has(key));
  if (unsupported) {
    throw new GatewayRequestError(
      'unsupported_parameter',
      unsupported,
      `Unsupported parameter: ${unsupported}.`,
    );
  }

  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!model) throw new GatewayRequestError('invalid_model', 'model', 'A model is required.');
  if (value.input === undefined) {
    throw new GatewayRequestError('invalid_input', 'input', 'input is required.');
  }
  if (typeof value.input !== 'string' && !Array.isArray(value.input)) {
    throw new GatewayRequestError('invalid_input', 'input', 'input must be a string or an array.');
  }
  if (value.stream !== undefined && typeof value.stream !== 'boolean') {
    throw new GatewayRequestError('invalid_stream', 'stream', 'stream must be a boolean.');
  }
  if (value.tools !== undefined && !Array.isArray(value.tools)) {
    throw new GatewayRequestError('invalid_tools', 'tools', 'tools must be an array.');
  }
  if (value.include !== undefined && !Array.isArray(value.include)) {
    throw new GatewayRequestError('invalid_include', 'include', 'include must be an array.');
  }

  let nestedEffort: unknown;
  if (value.reasoning !== undefined) {
    if (!isRecord(value.reasoning)) {
      throw new GatewayRequestError('invalid_reasoning_effort', 'reasoning', 'reasoning must be an object.');
    }
    const unsupportedReasoning = Object.keys(value.reasoning)
      .find((key) => !SUPPORTED_REASONING_FIELDS.has(key));
    if (unsupportedReasoning) {
      throw new GatewayRequestError(
        'unsupported_parameter',
        `reasoning.${unsupportedReasoning}`,
        `Unsupported parameter: reasoning.${unsupportedReasoning}.`,
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
    stream: value.stream === true,
    usesTools: Array.isArray(value.tools) && value.tools.length > 0,
  };
}

/** Replace server-owned routing fields and apply the exact Responses adapter. */
export function buildUpstreamResponsesPayload(
  request: ParsedResponsesRequest,
  resolved: GatewayResolvedModel,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...request.body };
  delete payload.reasoning_effort;
  payload.model = resolved.model.upstreamModelId;

  if (isRecord(payload.reasoning)) {
    const reasoning = { ...payload.reasoning };
    delete reasoning.effort;
    if (Object.keys(reasoning).length > 0) payload.reasoning = reasoning;
    else delete payload.reasoning;
  }

  if (resolved.selectedEffort === null) return payload;
  return applyModelEffortWireMap(
    payload,
    resolved.selectedEffort,
    endpointEffortWireMap(resolved, 'responses'),
  );
}

/** Read and validate a bounded non-streaming Responses object. */
export async function readBoundedResponsesJson(
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
  if (!isRecord(parsed) || (parsed.error !== undefined && parsed.error !== null) || !Array.isArray(parsed.output)) {
    throw new GatewayUpstreamProtocolError();
  }
  return parsed;
}

/** Keep the public model ID while preserving output items, tools, and usage. */
export function normalizeResponseObject(
  response: Record<string, unknown>,
  publicModelId: string,
): Record<string, unknown> {
  return { ...response, model: publicModelId };
}

export interface NormalizedResponsesSseEvent {
  text: string;
  done: boolean;
  failed: boolean;
  usage: GatewayTokenUsage | null;
}

const SANITIZED_STREAM_ERROR = Object.freeze({
  code: 'upstream_error',
  message: 'The upstream provider could not complete the request.',
});

/** Normalize one Responses SSE event and remove the private upstream model ID. */
export function normalizeResponsesSseEvent(
  event: string,
  publicModelId: string,
): NormalizedResponsesSseEvent {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!data) return { text: '', done: false, failed: false, usage: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new GatewayUpstreamProtocolError();
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    throw new GatewayUpstreamProtocolError();
  }
  if (parsed.type === 'error') {
    const normalized = {
      type: 'error',
      ...SANITIZED_STREAM_ERROR,
      param: null,
      ...(typeof parsed.sequence_number === 'number' && Number.isSafeInteger(parsed.sequence_number)
        ? { sequence_number: parsed.sequence_number }
        : {}),
    };
    return {
      text: `event: error\ndata: ${JSON.stringify(normalized)}\n\n`,
      done: true,
      failed: true,
      usage: null,
    };
  }
  if (parsed.error !== undefined && parsed.error !== null) {
    throw new GatewayUpstreamProtocolError();
  }
  if (!RESPONSES_EVENT_TYPE.test(parsed.type)) throw new GatewayUpstreamProtocolError();

  let normalized: Record<string, unknown> = { ...parsed };
  let usage: GatewayTokenUsage | null = null;
  if (isRecord(parsed.response)) {
    if (parsed.response.error !== undefined && parsed.response.error !== null) {
      if (parsed.type !== 'response.failed') throw new GatewayUpstreamProtocolError();
      normalized.response = {
        ...parsed.response,
        model: publicModelId,
        error: SANITIZED_STREAM_ERROR,
      };
    } else {
      normalized.response = { ...parsed.response, model: publicModelId };
    }
    usage = responsesTokenUsage(parsed.response.usage);
  }
  if (Object.hasOwn(parsed, 'model')) normalized.model = publicModelId;
  if (parsed.type === 'response.failed') {
    if (!isRecord(normalized.response)) throw new GatewayUpstreamProtocolError();
    normalized = {
      type: 'response.failed',
      response: normalized.response,
      ...(typeof parsed.sequence_number === 'number' && Number.isSafeInteger(parsed.sequence_number)
        ? { sequence_number: parsed.sequence_number }
        : {}),
    };
  }

  return {
    text: `event: ${parsed.type}\ndata: ${JSON.stringify(normalized)}\n\n`,
    done: ['response.completed', 'response.incomplete', 'response.failed'].includes(parsed.type),
    failed: parsed.type === 'response.failed',
    usage,
  };
}
