/**
 * Host lifecycle channel for ADR-032 learned state.
 *
 * This is deliberately an MCP custom request, not a tool. The Agent can only
 * dispatch names returned by tools/list through tools/call, while CLI/Desktop
 * hosts hold this typed protocol capability directly.
 */
export const HOST_LEARNING_REQUEST_METHOD = 'brainrouter/host-learning' as const;

export interface HostLearnedProjection {
  readonly schemaVersion: 1;
  readonly itemId: string;
  readonly tier: 'evidence' | 'instruction';
  readonly origin: 'model-inferred' | 'human-correction';
  readonly form: 'lesson' | 'procedure' | 'delegation';
  readonly status: 'active' | 'demoted' | 'retired' | 'reverted';
  readonly statusReason?: string;
  readonly statusChangedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly falsifier: string;
  readonly expectation: string;
  readonly provenance: {
    readonly sessionKey: string;
    readonly capturedAt: string;
    readonly checkpoint: 'turn-end' | 'compaction' | 'session-end';
    readonly evidence: readonly string[];
    readonly corroboratingActionIds?: readonly string[];
    readonly sawUntrustedContent: boolean;
    readonly gateReasoning: string;
  };
  readonly outcome: {
    readonly retrievals: number;
    readonly confirmations: number;
    readonly contradictions: number;
    readonly lastRetrievedAt?: string;
    readonly lastConfirmedAt?: string;
    readonly lastContradictedAt?: string;
  };
  readonly skillId?: string;
  readonly allowedTools?: readonly string[];
  readonly memoryLifecycle?: {
    readonly status: 'record-pending' | 'active' | 'archive-pending' | 'archived';
    readonly updatedAt: string;
    readonly attempts: number;
    readonly lastError?: string;
  };
}

/** Authenticated tenant identity returned by the BrainRouter host channel. */
export interface HostLearningIdentity {
  readonly userId: string;
  readonly orgId: string | null;
}

export type HostLearningRequest =
  | {
    readonly operation: 'identity';
  }
  | {
    readonly operation: 'correct';
    readonly input: {
      readonly itemId: string;
      readonly statement: string;
      readonly falsifier: string;
      readonly expectation: string;
    };
  }
  | {
    readonly operation: 'record';
    readonly input: {
      readonly text: string;
      readonly evidence?: string;
      readonly sessionKey?: string;
      readonly learned: HostLearnedProjection;
    };
  }
  | {
    readonly operation: 'revert';
    readonly input: {
      readonly itemId: string;
      readonly reason: string;
    };
  }
  | {
    readonly operation: 'outcome';
    readonly input: {
      readonly recordId: string;
      readonly itemId: string;
      readonly sessionIdentity: string;
      readonly outcome: 'confirmed' | 'contradicted';
      readonly detail: string;
    };
  }
  | {
    readonly operation: 'sync';
    readonly input: {
      readonly recordId: string;
      readonly itemId: string;
      readonly learned: HostLearnedProjection;
    };
  }
  | {
    readonly operation: 'lifecycle';
    readonly input: {
      readonly operation: 'inspect' | 'archive' | 'restore';
      readonly recordId: string;
      readonly itemId: string;
      readonly reason?: string;
    };
  };

export interface HostLearningResult {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{
    readonly type: 'text';
    readonly text: string;
  }>;
}
