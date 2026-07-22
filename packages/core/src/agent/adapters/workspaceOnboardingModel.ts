/**
 * Shared adapter for one bounded, read-only workspace-onboarding model call.
 *
 * Core owns the provider transport and proposal contract, so Desktop and CLI
 * must not drift on forced-tool selection, compatibility retries, aborts, or
 * response ceilings. Hosts only supply the active session model.
 */
import type { LLMConfig } from '../../config/configTypes.js';
import type { WorkspaceOnboardingModelRequest } from '../../workspace/assistedOnboarding.js';
import { ONBOARDING_PROPOSAL_MAX_RAW_BYTES } from '../../workspace/onboardingProposal.js';
import { callOpenAI } from '../transport/llmTransport.js';

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
