/**
 * Host-neutral delegation contracts.
 *
 * The task packet is the single bounded handoff used for in-process children
 * and cross-host delivery. Transport provenance wraps that packet without
 * changing its authority, capability, context, or budget ceilings.
 */

export type DelegationAccessMode = "read" | "write" | "shell";

export interface DelegatedTaskPacket {
  schemaVersion: 1;
  task: string;
  expectedOutput: {
    contractId: string | null;
    description: string;
    requiredSections: string[];
  };
  persona: { id: string };
  orchestration: {
    roleId: string;
    workspaceProfileId?: string;
    planProfileId?: string;
    /** @deprecated Compatibility alias for planProfileId. */
    profileId?: string;
    strategyId?: string;
    stageId?: string;
    skillIds?: string[];
    assignment?: string;
  };
  capabilities: {
    active: string[];
    reasons: string[];
    skillPacks: string[];
    skills: string[];
    toolProfiles: string[];
  };
  userConstraints: {
    goal?: { text: string; status: string };
    ownership?: string | null;
    workspaceInstructionsHash?: string;
    executionMode?: string;
    reviewPolicy?: string;
    constraints?: string[];
    deadline?: string;
  };
  planState?: string;
  memoryBriefing: {
    recordIds: string[];
    excerpt?: string;
  };
  sources: {
    files: string[];
  };
  contextLayers: Array<{
    kind: string;
    reference: string;
    protected: boolean;
  }>;
  toolPolicyCeiling: {
    accessMode: DelegationAccessMode;
    localTools: string[];
    mcpTools: string[];
    disallowedTools: string[];
  };
  budgets: {
    maxWallClockMs: number;
    maxPromptTokens: number;
    maxCompletionTokens: number;
    maxIterations: number;
    maxDepth: number;
    maxOutputChars: number;
  };
}

export interface DelegationOrigin {
  /** Authoritative session identity pinned by the authenticated transport. */
  fromSessionKey: string;
  /** Informational label resolved from the sender's active-session record. */
  originatingClient: string;
  /** Informational label resolved from the sender's active-session record. */
  originatingWorkspace: string;
  createdAt: string;
}

/** Canonical cross-host envelope: the shared task packet plus transport origin. */
export interface DelegationPacket extends DelegatedTaskPacket {
  origin: DelegationOrigin;
}

/**
 * Compatibility shape for rows written before the bounded task packet became
 * the cross-host contract. New writes never use this shape.
 */
export interface LegacyDelegationPacket {
  goal: string;
  fromSessionKey: string;
  originatingClient: string;
  originatingWorkspace: string;
  files: string[];
  constraints: string[];
  modelHints: string[];
  budget: { tokens?: number; usd?: number } | null;
  deadline: string | null;
  note?: string;
  createdAt: string;
}

export type StoredDelegationPacket =
  | DelegationPacket
  | LegacyDelegationPacket;
