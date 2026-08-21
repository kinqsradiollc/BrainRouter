// Behavior-preserving extraction from runTurn.impl.ts; the Agent facade and
// callback order remain unchanged.
import type { Agent, RunTurnCallbacks } from '../agent.js';
import { getCliKnobs, loadOrInitConfig } from '../../config/config.js';
import { recordTrajectoryStep } from '../../session/trace/trajectoryStore.js';
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
  effortForTurnSelection,
  InterruptError,
  isInterrupt,
} from '../transport/llmTransport.js';
// ADR-041 A41-5 — the provider-neutral streaming seam (wraps callOpenAIStream).
import { callProviderStream, type ProviderStreamResult } from '../transport/providerStream.js';
import { recoverAgentProviderRoute } from './providerRecovery.js';
import { ReviewProviderRequestBudgetExceededError } from './modelRequestBudget.js';
import { runPhaseWaterfall } from './phaseWaterfall.js';
import { phaseHookContributions } from '../../extension/registry.js';

export interface ModelPhaseResponse {
  content: string;
  toolCalls?: any[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  finishReason?: string;
}

/**
 * ADR-041 D4b.2 — thrown when a `provider-call` phase hook refuses (returns
 * without calling next()). NOT a server/connectivity error, so
 * `invokeLlmResilient` rethrows it without retrying; `invokeModelPhase` converts
 * it to a `provider-refused` terminal that closes a durable zero-step turn.
 */
export class ProviderCallRefusedError extends Error {
  constructor(readonly refusedBy: string) {
    super(`Provider call refused by extension "${refusedBy}" (provider-call phase).`);
    this.name = 'ProviderCallRefusedError';
  }
}

export type ModelInvocationResult =
  | { kind: 'response'; response: ModelPhaseResponse }
  | { kind: 'interrupted'; note: string }
  | { kind: 'provider-refused'; refusedBy: string };

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
  const reviewedExecution = agent.executionIntentTurnToolName() !== null
    || agent.inheritedExecutionAuthorityGuard() !== undefined;
  const invokeLlm = async (): Promise<ModelPhaseResponse> => {
    const contextWindowTokens = contextWindowForBudget(agent.llmConfig.model);
    const contextEnvelope = buildRootContextEnvelope(agent.chatHistory, {
      executionId: agent.turnExecutionId ?? agent.sessionKey,
      budget: {
        maxChars: contextWindowTokens * 4,
        maxTokens: contextWindowTokens,
      },
    });
    const requestMessages = sanitizeToolCallPairing(
      materializeContextEnvelope(contextEnvelope) as any[],
    );
    const activeMode = agent.reviewedExecutionPolicySnapshot()?.activeMode
      ?? resolveActiveMode(agent.workspaceRoot, agent.sessionKey);
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
    const requestBudget = agent.reviewSourceSafety
      ? { beforeProviderRequest: () => agent.reserveModelProviderRequest() }
      : {};
    const dispatch = async (): Promise<ModelPhaseResponse> => {
      if (streamRequested) {
        let started = false;
        try {
          // ADR-041 A41-5 — consume the provider-neutral StreamChunk stream instead
          // of registering delta callbacks + reading a separate return value. Same
          // deltas, same order, same final result (the terminal `done` chunk).
          let final: ProviderStreamResult | undefined;
          for await (const chunk of callProviderStream(
            agent.llmConfig,
            requestMessages,
            allTools,
            { effort, signal: agent.turnAbort?.signal, ...requestBudget },
          )) {
            if (chunk.type === 'text') {
              if (!started) {
                started = true;
                callbacks.onAssistantTurnStart?.();
              }
              callbacks.onAssistantDelta?.(chunk.delta);
            } else if (chunk.type === 'reasoning') {
              callbacks.onReasoningDelta?.(chunk.delta);
            } else {
              final = chunk.result;
            }
          }
          // The stream always terminates with a `done` chunk on success.
          const result = final!;
          if (started) callbacks.onAssistantTurnEnd?.(result.content);
          return {
            content: result.content,
            toolCalls: result.toolCalls,
            usage: result.usage,
            finishReason: result.finishReason,
          };
        } catch (streamError: any) {
          if (isInterrupt(streamError) || agent.interruptRequested) throw streamError;
          if (streamError instanceof ReviewProviderRequestBudgetExceededError) throw streamError;
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
        { effort, signal: agent.turnAbort?.signal, ...requestBudget },
      );
    };
    // ADR-041 D4b.2 — the provider-call waterfall. Gated on hookEnforceActive so
    // safeMode / reviewSourceSafety isolate a bad hook. No hooks ⇒ dispatch runs
    // directly (byte-identical). Registered hooks wrap the model dispatch: each
    // may pass through, or refuse to call next() and reject the call outright.
    const providerHooks = agent.hookEnforceActive()
      ? phaseHookContributions('provider-call')
      : [];
    if (providerHooks.length === 0) return dispatch();
    const requestSnapshot = JSON.stringify(requestMessages);
    const outcome = await runPhaseWaterfall(
      providerHooks,
      { phase: 'provider-call', workspaceRoot: agent.workspaceRoot, sessionKey: agent.sessionKey },
      async () => {
        // ADR-041 D4 logged invariant: after the hooks' pre-code and before the
        // model request is sent, the in-flight request array must be untouched —
        // a hook injects model-visible context via the transcript/history, never
        // by mutating `requestMessages` in place, or fork/resume/replay would lie.
        if (JSON.stringify(requestMessages) !== requestSnapshot) {
          throw new Error(
            'ADR-041 D4 logged-invariant violation (provider-call): a phase hook '
            + 'mutated the in-flight request message array. Inject context via '
            + 'history/transcript, not by mutating messages in place.',
          );
        }
        return dispatch();
      },
    );
    if (!outcome.ran) throw new ProviderCallRefusedError(outcome.refusedBy ?? 'a phase hook');
    return outcome.result!;
  };

  const maxReconnects = Math.max(
    0,
    agent.maxLlmReconnectsPerCall ?? getCliKnobs().llmMaxReconnects,
  );
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

    // ADR-041 D4b.2 — a provider-call hook refused; it is non-retryable, so it
    // propagated here. Close the turn as a zero-step attempt (the terminal in
    // runTurn records it to the transcript), never a retryable provider failure.
    if (error instanceof ProviderCallRefusedError) {
      return { kind: 'provider-refused', refusedBy: error.refusedBy };
    }

    const message = String(error?.message ?? error);
    const routerKnobs = getCliKnobs().router;
    if (routerKnobs.enabled && !reviewedExecution) {
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
              agent.setLLMConfig(route.llm);
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
        !reviewedExecution
        && isModelNotFoundError(message)
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

  // ADR-041 D14 (#2/#3) — record this model call as one step in the session's
  // trajectory ledger, keyed off the FINALIZED response so a step is recorded no
  // matter which attempt produced it (first try, reconnect, router/model
  // fallback, or a post-compaction retry) — a glass box must not go blank on the
  // exact turns something went wrong. `at` is the step's start (before the first
  // attempt), so `durationMs` is the whole step's wall-clock, recovery included.
  // Opt-in and log-only, so a replay is byte-identical whether it is on or off;
  // fully guarded so a trace write can never affect the turn.
  if (getCliKnobs().traceTrajectory === true) {
    try {
      recordTrajectoryStep(agent.workspaceRoot, agent.sessionKey, {
        model: agent.llmConfig.model,
        at: providerAttemptStartedAt,
        durationMs: Date.now() - Date.parse(providerAttemptStartedAt),
        tokensIn: response.usage?.prompt_tokens,
        tokensOut: response.usage?.completion_tokens,
        toolNames: (response.toolCalls ?? [])
          .map((tc: any) => tc?.function?.name ?? tc?.name)
          .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0),
        text: response.content,
      });
    } catch {
      /* never break a turn on a metadata write */
    }
  }

  return { kind: 'response', response };
}
