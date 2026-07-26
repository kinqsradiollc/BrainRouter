import type { OrchestrationRuntimePort } from '../../tool/registry/executors.js';

export type OrchestrationRuntimeUnavailableReason =
  | 'missing-port'
  | 'turn-ended'
  | 'turn-interrupted'
  | 'session-changed';

export class OrchestrationRuntimeUnavailableError extends Error {
  readonly code = 'orchestration-runtime-unavailable';
  readonly terminal = true;
  readonly retryable = false;

  constructor(
    readonly toolName: string,
    readonly reason: OrchestrationRuntimeUnavailableReason,
  ) {
    const detail = reason === 'turn-interrupted'
      ? 'the owning turn was interrupted'
      : reason === 'session-changed'
        ? 'the owning session changed'
        : reason === 'turn-ended'
          ? 'the owning active turn ended'
          : 'no active turn owns an orchestration runtime';
    super(`${toolName}: ${detail}; delegation was not started and must not be retried.`);
    this.name = 'OrchestrationRuntimeUnavailableError';
  }
}

export function isOrchestrationRuntimeUnavailableError(
  error: unknown,
): error is OrchestrationRuntimeUnavailableError {
  return error instanceof OrchestrationRuntimeUnavailableError
    || (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'orchestration-runtime-unavailable'
    );
}

export interface ActiveTurnOrchestrationRuntime {
  port: OrchestrationRuntimePort;
  assertActive(toolName: string): void;
  close(): void;
}

/**
 * Create a non-retainable orchestration port for one active local-tool call.
 * Closing the owner makes any captured/deferred invocation fail terminally.
 */
export function createActiveTurnOrchestrationRuntime(input: {
  ownerSessionKey: string;
  currentSessionKey: () => string;
  signal: AbortSignal;
  invoke: OrchestrationRuntimePort['invoke'];
}): ActiveTurnOrchestrationRuntime {
  let active = true;
  const assertActive = (toolName: string): void => {
    if (!active) {
      throw new OrchestrationRuntimeUnavailableError(toolName, 'turn-ended');
    }
    if (input.signal.aborted) {
      throw new OrchestrationRuntimeUnavailableError(toolName, 'turn-interrupted');
    }
    if (input.currentSessionKey() !== input.ownerSessionKey) {
      throw new OrchestrationRuntimeUnavailableError(toolName, 'session-changed');
    }
  };
  const runtime: ActiveTurnOrchestrationRuntime = {
    port: {
      invoke: async (toolName, args, metadata) => {
        assertActive(toolName);
        return input.invoke(toolName, args, metadata);
      },
    },
    assertActive,
    close: () => {
      active = false;
    },
  };
  return runtime;
}
