/**
 * Shared adapter for one bounded managed orchestration-strategy choice.
 *
 * Hosts provide the active managed/session model. Core owns the forced-tool,
 * single-call, abort, compatibility-retry, and response-size contract.
 */
import type { LLMConfig } from '../../config/configTypes.js';
import {
  ADAPTIVE_STRATEGY_MAX_OUTPUT_BYTES,
  type AdaptiveStrategySelectionModelRequest,
} from '../../orchestration/profiles/adaptiveStrategySelectionModel.js';
import { callOpenAI } from '../transport/llmTransport.js';

interface ModelResponse {
  content?: unknown;
  toolCalls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
}

export type OrchestrationStrategyModelCall = (
  config: LLMConfig,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  tools: Array<{ name: string; description: string; inputSchema: unknown }>,
  options: {
    effort: 'low';
    signal: AbortSignal;
    tool_choice: AdaptiveStrategySelectionModelRequest['toolChoice'];
    allowCompatibilityRetry: false;
    maxResponseBytes: number;
  },
) => Promise<ModelResponse>;

const TRANSPORT_ENVELOPE_BYTES = 32 * 1024;

export async function completeOrchestrationStrategyWithModel(
  llm: LLMConfig,
  request: AdaptiveStrategySelectionModelRequest,
  invoke: OrchestrationStrategyModelCall = callOpenAI,
): Promise<string> {
  if (
    !Number.isSafeInteger(request.maxOutputBytes)
    || request.maxOutputBytes < 1
    || request.maxOutputBytes > ADAPTIVE_STRATEGY_MAX_OUTPUT_BYTES
  ) {
    throw new Error('Invalid orchestration strategy model-output limit.');
  }

  const response = await invoke(
    llm,
    [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    [{
      name: request.tool.name,
      description: request.tool.description,
      inputSchema: request.tool.parameters,
    }],
    {
      effort: 'low',
      signal: request.signal,
      tool_choice: request.toolChoice,
      allowCompatibilityRetry: false,
      maxResponseBytes: request.maxOutputBytes + TRANSPORT_ENVELOPE_BYTES,
    },
  );

  const matching = response.toolCalls?.find(
    (call) => call.function?.name === request.tool.name,
  );
  const candidate = matching?.function?.arguments ?? response.content;
  const raw = typeof candidate === 'string'
    ? candidate
    : JSON.stringify(candidate ?? '');
  if (Buffer.byteLength(raw) > request.maxOutputBytes) {
    throw new Error('Orchestration strategy model output exceeded the byte limit.');
  }
  return raw;
}
