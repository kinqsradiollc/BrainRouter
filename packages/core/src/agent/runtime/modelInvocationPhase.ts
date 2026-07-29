// Behavior-preserving extraction from runTurn.impl.ts; the Agent facade and
// callback order remain unchanged.
import type { Agent, RunTurnCallbacks } from '../agent.js';
import { getCliKnobs, loadOrInitConfig } from '../../config/config.js';
import { contextWindowForBudget } from '../../context/contextWindow.js';
import {
  buildRootContextEnvelope,
  materializeContextEnvelope,
} from '../../context/contextEnvelope.js';
import { reconnectBackoffMs, probeConnectivity } from '../../mcp/reconnect/reconnect.js';
import { isModelNotFoundError, nextFallbackModel } from '../../provider/modelFallback.js';
import {
  buildModelRegistry,
  classifyRouterFailure,
  getRouterPolicy,
  resolveRoutes,
  type RouterFailure,
} from '../../provider/routing/index.js';
import { resolveActiveMode } from '../../session/state/sessionModeStore.js';
import { isConnectivityError, isRetryableServerError } from '../../storage/checkpointStore.js';
import { traceEvent } from '../../telemetry/tracing/tracing.js';
import { sanitizeToolCallPairing } from '../guards/toolCallRecovery.js';
import { resolveEffortForTurn } from '../support/effortRouting.js';
import {
  abortableDelay,
  callOpenAI,
  callOpenAIStream,
  effortForTurnSelection,
  InterruptError,
  isInterrupt,
} from '../transport/llmTransport.js';
import { recoverAgentProviderRoute } from './providerRecovery.js';

export interface ModelPhaseResponse {
  content: string;
  toolCalls?: any[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  finishReason?: string;
}

export type ModelInvocationResult =
  | { kind: 'response'; response: ModelPhaseResponse }
  | { kind: 'interrupted'; note: string };

function sameLlmRoute(
  route: { llm: { model: string; endpoint?: string; apiKey?: string } },
  llm: { model: string; endpoint?: string; apiKey?: string },
): boolean {
  return route.llm.model === llm.model
    && (route.llm.endpoint ?? '') === (llm.endpoint ?? '')
    && (route.llm.apiKey ?? '') === (llm.apiKey ?? '');
}

function routeFailureStatus(failure: RouterFailure): string {
  return failure.status ? `${failure.status}` : failure.kind.replace(/_/g, ' ');
}

/**
 * Execute one model phase, including transport recovery. The caller retains
 * turn-loop, tier-escalation, usage, tool execution, and completion ownership.
 */
export async function invokeModelPhase(
  agent: Agent,
  callbacks: RunTurnCallbacks,
  allTools: any[],
): Promise<ModelInvocationResult> {
  const invokeLlm = async (): Promise<ModelPhaseResponse> => {
    const contextWindowTokens = contextWindowForBudget(agent.llmConfig.model);
    const contextEnvelope = buildRootContextEnvelope(agent.chatHistory, {
      executionId: agent.sessionKey,
      budget: {
        maxChars: contextWindowTokens * 4,
        maxTokens: contextWindowTokens,
      },
    });
    const requestMessages = sanitizeToolCallPairing(
      materializeContextEnvelope(contextEnvelope) as any[],
    );
    const activeMode = resolveActiveMode(agent.workspaceRoot, agent.sessionKey);
    const selectedEffort = effortForTurnSelection(
      activeMode,
      agent.llmConfig.model,
      agent.effortOverride,
    );
    const effort = resolveEffortForTurn(
      selectedEffort,
      agent.chatHistory,
      getCliKnobs(),
    );
    const streamRequested = Boolean(
      callbacks.onAssistantDelta || callbacks.onReasoningDelta,
    ) && getCliKnobs().disableStream !== true;
    if (streamRequested) {
      let started = false;
      try {
        const final = await callOpenAIStream(
          agent.llmConfig,
          requestMessages,
          allTools,
          { effort, signal: agent.turnAbort?.signal },
          {
            onTextDelta: (text) => {
              if (!started) {
                started = true;
                callbacks.onAssistantTurnStart?.();
              }
              callbacks.onAssistantDelta?.(text);
            },
            onReasoningDelta: (text) => callbacks.onReasoningDelta?.(text),
          },
        );
        if (started) callbacks.onAssistantTurnEnd?.(final.content);
        return {
          content: final.content,
          toolCalls: final.toolCalls,
          usage: final.usage,
          finishReason: final.finishReason,
        };
      } catch (streamError: any) {
        if (isInterrupt(streamError) || agent.interruptRequested) throw streamError;
        if (started) {
          streamError.brainrouterStreamStarted = true;
          callbacks.onAssistantTurnEnd?.('');
          throw streamError;
        }
        callbacks.onStatusUpdate(
          `Streaming failed (${String(streamError?.message ?? streamError).slice(0, 120)}) — falling back to non-streaming.`,
        );
      }
    }
    return callOpenAI(
      agent.llmConfig,
      requestMessages,
      allTools,
      { effort, signal: agent.turnAbort?.signal },
    );
  };

  const maxReconnects = Math.max(1, getCliKnobs().llmMaxReconnects);
  const offlineMaxWaits = 120;
  const llmEndpoint = agent.llmConfig?.endpoint ?? '';
  const invokeLlmResilient = async (): Promise<ModelPhaseResponse> => {
    agent.recordPrefixStability(agent.chatHistory, allTools);
    let attempt = 0;
    let offlineWaits = 0;
    for (;;) {
      if (agent.interruptRequested) throw new InterruptError();
      try {
        return await invokeLlm();
      } catch (error: any) {
        if (agent.interruptRequested || isInterrupt(error)) {
          throw isInterrupt(error) ? error : new InterruptError();
        }
        const serverSide = isRetryableServerError(error);
        if (!serverSide && !isConnectivityError(error)) throw error;
        const online = serverSide ? true : await probeConnectivity(llmEndpoint);
        if (!online) {
          if (offlineWaits >= offlineMaxWaits) throw error;
          offlineWaits += 1;
          const delay = reconnectBackoffMs(Math.min(offlineWaits, 6), {
            capMs: 15_000,
          });
          callbacks.onStatusUpdate(
            `Waiting for connection… offline — retrying in ${(delay / 1000).toFixed(1)}s (${offlineWaits})`,
          );
          await abortableDelay(delay, agent.turnAbort?.signal);
          continue;
        }
        attempt += 1;
        if (attempt > maxReconnects) throw error;
        const retryAfterMs = typeof error?.retryAfterMs === 'number'
          ? error.retryAfterMs
          : undefined;
        const delay = reconnectBackoffMs(attempt, { retryAfterMs });
        callbacks.onStatusUpdate(
          `Reconnecting… ${attempt}/${maxReconnects} — ${String(error?.message ?? error).slice(0, 60)} (in ${(delay / 1000).toFixed(1)}s)`,
        );
        await abortableDelay(delay, agent.turnAbort?.signal);
      }
    }
  };

  let response: ModelPhaseResponse | undefined;
  const providerAttemptStartedAt = new Date().toISOString();
  try {
    response = await invokeLlmResilient();
  } catch (error: any) {
    if (isInterrupt(error) || agent.interruptRequested) {
      agent.interruptRequested = false;
      const interruptMessage = {
        role: 'system',
        content: 'The user interrupted this turn before it finished; the work above may be incomplete.',
      };
      agent.chatHistory.push(interruptMessage);
      agent.recordTranscript(interruptMessage);
      callbacks.onStatusUpdate('Interrupted');
      return { kind: 'interrupted', note: '⏹ Turn interrupted by user.' };
    }

    const message = String(error?.message ?? error);
    const routerKnobs = getCliKnobs().router;
    if (routerKnobs.enabled) {
      const failure = classifyRouterFailure(error);
      if (failure.retryable) {
        const config = loadOrInitConfig();
        const baseName = config.providers?.base ? 'base-config' : 'base';
        const providers = { ...(config.providers ?? {}), [baseName]: agent.llmConfig };
        const primaryChain = [
          ...routerKnobs.chain,
          ...getCliKnobs().fallbackModels,
          `${baseName}/${agent.llmConfig.model}`,
        ];
        const registry = buildModelRegistry(providers, {
          aliases: routerKnobs.aliases,
          chain: primaryChain,
          order: routerKnobs.order,
          strategy: routerKnobs.strategy,
          passThrough: routerKnobs.passThrough,
          availableModels: getCliKnobs().availableModels,
          enforceAvailableModels: getCliKnobs().enforceAvailableModels,
        });
        const policy = getRouterPolicy({
          cooldownBaseMs: routerKnobs.cooldownBaseMs,
          cooldownMaxMs: routerKnobs.cooldownMaxMs,
          sessionAffinity: routerKnobs.sessionAffinity,
          strategy: routerKnobs.strategy,
        });
        const resolvedRoutes = resolveRoutes(registry, agent.llmConfig.model, {
          withFallbacks: true,
          sessionKey: agent.sessionKey,
        });
        const failedRoute = resolvedRoutes.find((route) =>
          sameLlmRoute(route, agent.llmConfig)
        );
        const initialRoute = failedRoute ?? {
          slug: `${agent.llmConfig.provider}/${agent.llmConfig.model}`,
          provider: agent.llmConfig.provider,
          model: agent.llmConfig.model,
          llm: { ...agent.llmConfig },
          label: agent.llmConfig.model,
        };
        let attemptedRouterFallback = false;
        try {
          const recovery = await recoverAgentProviderRoute({
            initialRoute,
            initialError: error,
            initialStartedAt: providerAttemptStartedAt,
            routes: resolvedRoutes.filter((route) => (
              route.slug === initialRoute.slug || !sameLlmRoute(route, agent.llmConfig)
            )),
            triedRoutes: agent.triedRouterRoutes,
            policy,
            sessionKey: agent.sessionKey,
            onReceipt: callbacks.onProviderRecovery,
            onFallback: ({ to }) => {
              attemptedRouterFallback = true;
              const from = `${agent.llmConfig.provider}/${agent.llmConfig.model}`;
              callbacks.onStatusUpdate(
                `Router fallback: ${from} unavailable (${routeFailureStatus(failure)}) — trying ${to.slug}...`,
              );
              agent.recordTranscript({
                role: 'system',
                name: 'router',
                content: `router: ${from} unavailable (${routeFailureStatus(failure)}), routed to ${to.slug}`,
              });
              traceEvent('router.fallback', {
                from,
                to: to.slug,
                reason: failure.kind,
                status: failure.status ?? null,
              });
            },
            execute: async (route) => {
              agent.llmConfig = { ...route.llm };
              return invokeLlmResilient();
            },
          });
          response = recovery.result;
        } catch (recoveryError: any) {
          if (attemptedRouterFallback) {
            throw new Error(
              `LLM Execution failed after router fallback: ${recoveryError?.message ?? recoveryError}`,
            );
          }
        }
      }
    }

    if (!response) {
      const contextOverflow =
        /context length|context window|maximum context|too many tokens|reduce the length|prompt is too long|413|tokens? exceed/i.test(message);
      if (contextOverflow && !agent.silent && agent.chatHistory.length > 6) {
        callbacks.onStatusUpdate('Context overflow detected — reactive compaction before retry...');
        try {
          const beforeLength = agent.chatHistory.length;
          const compacted = await agent.compactHistory();
          if (compacted && callbacks.onCompactionEvent) {
            callbacks.onCompactionEvent({
              droppedMessages: Math.max(0, beforeLength - agent.chatHistory.length),
              keptMessages: agent.chatHistory.length,
              summary: compacted.summary,
            });
          }
          response = await invokeLlmResilient();
        } catch (retryError: any) {
          throw new Error(
            `LLM Execution failed after reactive compaction: ${retryError?.message ?? retryError}`,
          );
        }
      } else if (
        isModelNotFoundError(message)
        && (() => {
          agent.triedModels.add((agent.llmConfig.model ?? '').trim());
          return nextFallbackModel(
            agent.llmConfig.model,
            getCliKnobs().fallbackModels,
            agent.triedModels,
          ) !== null;
        })()
      ) {
        const from = agent.llmConfig.model;
        const fallback = nextFallbackModel(
          from,
          getCliKnobs().fallbackModels,
          agent.triedModels,
        ) as string;
        agent.triedModelFallback = true;
        agent.triedModels.add(fallback);
        agent.setModel(fallback);
        callbacks.onStatusUpdate(
          `Model "${from}" unavailable — falling back to ${fallback}...`,
        );
        try {
          response = await invokeLlmResilient();
        } catch (retryError: any) {
          throw new Error(
            `LLM Execution failed after model fallback (${from} → ${fallback}): ${retryError?.message ?? retryError}`,
          );
        }
      } else {
        throw new Error(`LLM Execution failed: ${message}`);
      }
    }
  }

  if (!response) throw new Error('LLM Execution failed: no response returned.');
  return { kind: 'response', response };
}
