/**
 * FED-S5 (0.4.2) — cross-vendor delegation, CLI side.
 *
 * The brain's `session_delegate_task` packages a vendor-neutral
 * {@link DelegationPacket} and routes it to an idle peer (or parks it).
 * When THIS CLI receives/claims a delegation, it must translate the packet
 * into the shape its own (or a target's) harness expects — that's the
 * FED-S5-T3 "vendor adapters" job, implemented here as pure functions so
 * they unit-test without a live brain.
 *
 * Two harness families:
 *   - goal-native (`brainrouter-cli`): adopt the packet as a fresh local
 *     goal (it already has goal/plan machinery).
 *   - prompt-driven (`claude-code`, `codex`, …): render the packet into a
 *     single self-contained instruction prompt.
 */

import {
  buildDelegatedTaskPacket,
  normalizeStoredDelegationPacket,
} from "@kinqs/brainrouter-core/orchestration/delegation-contracts";
import type {
  DelegatedTaskPacket,
  StoredDelegationPacket,
} from "@kinqs/brainrouter-types/agent";

export interface DelegationPayloadInput {
  goal: string;
  files?: string[];
  constraints?: string[];
  modelHints?: string[];
  budget?: { tokens?: number; usd?: number } | null;
  deadline?: string | null;
  note?: string;
  originatingClient: string;
  originatingWorkspace: string;
  /** Pre-resolved parent-authority subset. Omit for a read-only, tool-free handoff. */
  taskPacket?: DelegatedTaskPacket;
}

/**
 * Build the `payload` object the CLI sends to `session_delegate_task`.
 * The brain finalizes it into a full packet (adds `fromSessionKey` +
 * `createdAt`); this just normalizes what the sender controls.
 */
export function buildDelegationPayload(input: DelegationPayloadInput): Record<string, unknown> {
  const taskPacket = input.taskPacket ?? buildDelegatedTaskPacket({
    task: input.goal,
    personaId: "custom",
    roleId: "worker",
    capabilities: {
      active: [],
      reasons: ["cross-host handoff has no implicit capabilities"],
      skillPacks: [],
      skills: [],
      toolProfiles: [],
      promptBlocks: [],
    },
    accessMode: "read",
    constraints: [
      ...(input.constraints ?? []),
      ...(input.note?.trim() ? [input.note.trim()] : []),
    ],
    deadline: input.deadline,
    sourceFiles: input.files,
    localTools: [],
    mcpTools: [],
    disallowedTools: [],
    budgets: {
      maxWallClockMs: 1_800_000,
      maxPromptTokens: input.budget?.tokens ?? 100_000,
      maxCompletionTokens: 16_000,
      maxIterations: 250,
      maxDepth: 3,
      maxOutputChars: 24_000,
    },
  });
  return {
    taskPacket,
    // Compatibility projection for older servers; current servers re-bound
    // taskPacket and ignore these fields for authority.
    goal: input.goal.trim(),
    files: input.files ?? [],
    constraints: input.constraints ?? [],
    modelHints: input.modelHints ?? [],
    budget: input.budget ?? null,
    deadline: input.deadline ?? null,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    originatingClient: input.originatingClient,
    originatingWorkspace: input.originatingWorkspace,
  };
}

/** Render the canonical packet into one self-contained instruction string. */
export function renderDelegationPrompt(packet: StoredDelegationPacket): string {
  const normalized = normalizeStoredDelegationPacket(packet);
  const lines: string[] = [];
  lines.push(`# Delegated task`);
  lines.push("");
  lines.push(normalized.task.trim());
  if (normalized.sources.files.length) {
    lines.push("");
    lines.push(`## Files`);
    for (const f of normalized.sources.files) lines.push(`- ${f}`);
  }
  if (normalized.userConstraints.constraints?.length) {
    lines.push("");
    lines.push(`## Constraints`);
    for (const c of normalized.userConstraints.constraints) lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push(`## Authority ceiling`);
  lines.push(`- Access: ${normalized.toolPolicyCeiling.accessMode}`);
  lines.push(`- Local tools: ${normalized.toolPolicyCeiling.localTools.join(", ") || "none"}`);
  lines.push(`- Connected tools: ${normalized.toolPolicyCeiling.mcpTools.join(", ") || "none"}`);
  lines.push(`- Active capabilities: ${normalized.capabilities.active.join(", ") || "none"}`);
  lines.push(`- Maximum child depth: ${normalized.budgets.maxDepth}`);
  lines.push(`- Maximum iterations: ${normalized.budgets.maxIterations}`);
  if (normalized.userConstraints.deadline) {
    lines.push(`- Deadline: ${normalized.userConstraints.deadline}`);
  }
  lines.push("");
  lines.push(
    `_(Delegated from ${normalized.origin.originatingClient}${normalized.origin.originatingWorkspace ? ` @ ${normalized.origin.originatingWorkspace}` : ""}.)_`,
  );
  return lines.join("\n");
}

export type DelegationAdaptation =
  | { clientKind: string; mode: "goal"; goal: string; note?: string }
  | { clientKind: string; mode: "prompt"; prompt: string };

export type DelegationAdapter = (packet: StoredDelegationPacket) => DelegationAdaptation;

/** brainrouter-cli is goal-native — adopt the packet as a local goal. */
const brainrouterCliAdapter: DelegationAdapter = (packet) => ({
  clientKind: "brainrouter-cli",
  mode: "goal",
  goal: normalizeStoredDelegationPacket(packet).task.trim(),
  note: renderDelegationPrompt(packet),
});

/** Prompt-driven harnesses consume a single composed instruction. */
function promptAdapter(clientKind: string): DelegationAdapter {
  return (packet) => ({ clientKind, mode: "prompt", prompt: renderDelegationPrompt(packet) });
}

export const DELEGATION_ADAPTERS: Record<string, DelegationAdapter> = {
  "brainrouter-cli": brainrouterCliAdapter,
  "claude-code": promptAdapter("claude-code"),
  codex: promptAdapter("codex"),
};

/**
 * Translate a delegation packet for the given local harness. Unknown
 * kinds fall back to the prompt shape (the safest universal form).
 */
export function adaptDelegationFor(clientKind: string, packet: StoredDelegationPacket): DelegationAdaptation {
  const key = clientKind.trim().toLowerCase();
  const adapter = DELEGATION_ADAPTERS[key] ?? promptAdapter(key || "unknown");
  return adapter(packet);
}
