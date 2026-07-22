/**
 * Desktop adapter for one bounded, read-only workspace-onboarding model call.
 *
 * The core service owns prompting, timeout, parsing, and deterministic fallback.
 * This adapter only binds the active Desktop session model to that port while
 * forcing the proposal tool and enforcing the raw-output ceiling at transport
 * and extraction boundaries.
 */
import { callOpenAI } from '@kinqs/brainrouter-core/agent';
import type { LLMConfig } from '@kinqs/brainrouter-core/config';
import {
  ONBOARDING_PROPOSAL_MAX_RAW_BYTES,
  type WorkspaceOnboardingModelRequest,
} from '@kinqs/brainrouter-core/workspace';

interface ModelResponse {
  content?: unknown;
  toolCalls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
}

export type WorkspaceOnboardingModelCall = (
  config: LLMConfig,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  tools: Array<{ name: string; description: string; inputSchema: unknown }>,
  options: {
    effort: 'low';
    signal: AbortSignal;
    tool_choice: WorkspaceOnboardingModelRequest['toolChoice'];
    allowCompatibilityRetry: false;
    maxResponseBytes: number;
  },
) => Promise<ModelResponse>;

const TRANSPORT_ENVELOPE_BYTES = 64 * 1024;

export async function completeWorkspaceOnboardingWithModel(
  llm: LLMConfig,
  request: WorkspaceOnboardingModelRequest,
  invoke: WorkspaceOnboardingModelCall = callOpenAI,
): Promise<string> {
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 ||
      request.maxOutputBytes > ONBOARDING_PROPOSAL_MAX_RAW_BYTES) {
    throw new Error('Invalid workspace onboarding model-output limit.');
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
  const raw = typeof candidate === 'string' ? candidate : JSON.stringify(candidate ?? '');
  if (Buffer.byteLength(raw) > request.maxOutputBytes) {
    throw new Error('Workspace onboarding model output exceeded the byte limit.');
  }
  return raw;
}
