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

import type { DelegationPacket } from "@kinqs/brainrouter-types";

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
}

/**
 * Build the `payload` object the CLI sends to `session_delegate_task`.
 * The brain finalizes it into a full packet (adds `fromSessionKey` +
 * `createdAt`); this just normalizes what the sender controls.
 */
export function buildDelegationPayload(input: DelegationPayloadInput): Record<string, unknown> {
  return {
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

/** Render the packet into a single self-contained instruction string. */
export function renderDelegationPrompt(packet: DelegationPacket): string {
  const lines: string[] = [];
  lines.push(`# Delegated task`);
  lines.push("");
  lines.push(packet.goal.trim());
  if (packet.files.length) {
    lines.push("");
    lines.push(`## Files`);
    for (const f of packet.files) lines.push(`- ${f}`);
  }
  if (packet.constraints.length) {
    lines.push("");
    lines.push(`## Constraints`);
    for (const c of packet.constraints) lines.push(`- ${c}`);
  }
  if (packet.modelHints.length) {
    lines.push("");
    lines.push(`## Model hints`);
    for (const h of packet.modelHints) lines.push(`- ${h}`);
  }
  const limits: string[] = [];
  if (packet.budget?.tokens) limits.push(`${packet.budget.tokens} tokens`);
  if (packet.budget?.usd) limits.push(`$${packet.budget.usd}`);
  if (packet.deadline) limits.push(`deadline ${packet.deadline}`);
  if (limits.length) {
    lines.push("");
    lines.push(`## Budget / deadline`);
    lines.push(limits.join(" · "));
  }
  if (packet.note) {
    lines.push("");
    lines.push(`> ${packet.note}`);
  }
  lines.push("");
  lines.push(
    `_(Delegated from ${packet.originatingClient}${packet.originatingWorkspace ? ` @ ${packet.originatingWorkspace}` : ""}.)_`,
  );
  return lines.join("\n");
}

export type DelegationAdaptation =
  | { clientKind: string; mode: "goal"; goal: string; note?: string }
  | { clientKind: string; mode: "prompt"; prompt: string };

export type DelegationAdapter = (packet: DelegationPacket) => DelegationAdaptation;

/** brainrouter-cli is goal-native — adopt the packet as a local goal. */
const brainrouterCliAdapter: DelegationAdapter = (packet) => ({
  clientKind: "brainrouter-cli",
  mode: "goal",
  goal: packet.goal.trim(),
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
export function adaptDelegationFor(clientKind: string, packet: DelegationPacket): DelegationAdaptation {
  const key = clientKind.trim().toLowerCase();
  const adapter = DELEGATION_ADAPTERS[key] ?? promptAdapter(key || "unknown");
  return adapter(packet);
}
