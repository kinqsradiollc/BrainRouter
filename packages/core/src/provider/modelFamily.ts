/**
 * HONK-L1/L7 — model-family classification + the local-model harness profile.
 *
 * One source of truth for "is this a strong agentic model vs a small/local one",
 * shared by the system-prompt autonomy overlay and the bounded-harness profile.
 * The Honk lesson: a tight bounded harness — not more prompt — is what makes weak
 * local models reliable. So for positively-identified local families we clamp the
 * turn-loop caps; strong or UNKNOWN models are never clamped (an unknown-but-capable
 * model must not be hobbled).
 *
 * Pure leaf: imports nothing, so `config` and the agent loop can both consume it
 * without an import cycle.
 */

/** Strong, agentic-grade families that need no autonomy reinforcement or clamping. */
export function isStrongModelFamily(model: string | undefined): boolean {
  if (!model) return false;
  const id = model.toLowerCase();
  const strong = [
    /^claude-/, // any Anthropic Claude
    /^anthropic\//, // OpenRouter / OpenAI-compatible prefixes
    /^gpt-4/, // gpt-4, gpt-4o, gpt-4.1, gpt-4-turbo
    /^gpt-5/, // gpt-5, gpt-5-mini, gpt-5-pro, gpt-5-codex
    /^o[134](-|$)/, // o1, o3, o4 + dated variants
    /^chatgpt-/, // chatgpt-4o-latest etc.
    /^gemini-2\.5/, // Gemini 2.5 Pro / Flash
    /^openai\/gpt-4/,
    /^openai\/gpt-5/,
  ];
  return strong.some((re) => re.test(id));
}

/**
 * Positively identify small/local OSS families that benefit from the tighter
 * bounded harness. Intentionally NOT "everything that isn't strong" — an
 * unknown-but-capable model must not get clamped (the plan's L1 risk note:
 * too-low caps aborted a legitimate long workflow).
 */
export function isLocalModelFamily(model: string | undefined): boolean {
  if (!model) return false;
  const id = model.toLowerCase();
  const local = [
    /(^|[/:_-])gpt-oss/,
    /llama/, // llama, codellama, tinyllama
    /qwen/,
    /mistral/,
    /mixtral/,
    /deepseek/,
    /gemma/,
    /phi-?\d/,
    /starcoder/,
    /(^|[/:_-])yi-/,
    /command-r/,
    /granite/,
    /smollm/,
    /openhermes/,
    /nous-?hermes/,
    /dolphin/,
    /vicuna/,
    /wizardlm/,
    /(^|[/:_-])ollama/,
    /lmstudio/,
  ];
  return local.some((re) => re.test(id));
}

/**
 * HONK-L2 — the hard tool allowlist for local models. When the profile is active,
 * the built-in tool surface is pinned to this core set and the long tail (computer
 * use, web/research, LSP, worker threads, artifacts, track, MCP-resource browsing,
 * catalog refresh) is hidden — a small surface is what weak models handle reliably.
 * Orchestration tools (task_agent/delegate_agent) are added elsewhere and are NOT
 * affected here, so delegation still works.
 *
 * Deliberately GENEROUS on lifecycle/turn-control (plan, finish, ask, chapter) so a
 * clamped model can still drive and end a turn.
 */
export const LOCAL_MODEL_CORE_TOOLS: ReadonlySet<string> = new Set<string>([
  // file + search + edit + shell — the Honk core allowlist
  'read_file',
  'write_file',
  'edit_file',
  'apply_patch',
  'list_dir',
  'grep_search',
  'glob_files',
  'run_command',
  // turn control / lifecycle — must stay so the model can plan + end its turn
  'update_plan',
  'goal_complete',
  'goal_blocked',
  'mark_chapter',
  'ask_user_choice',
  'extract_result',
  'task_output',
  // bounded waits + the MCP discovery entrypoints (when progressive discovery is on)
  'wait_until',
  'wait_worker',
  'mcp_search',
  'mcp_describe',
  'mcp_call',
  'read_mcp_resource',
]);

/** True when `name` is in the local-model core allowlist (HONK-L2). */
export function isLocalModelCoreTool(name: string): boolean {
  return LOCAL_MODEL_CORE_TOOLS.has(name);
}

/** Whether the local-model profile is active for `model` under `mode`
 *  (shared gate for the caps clamp AND the tool allowlist). */
export function localModelProfileActive(model: string | undefined, mode: LocalModelProfileMode): boolean {
  return mode === 'on' || (mode === 'auto' && isLocalModelFamily(model));
}

export type LocalModelProfileMode = 'auto' | 'on' | 'off';

/** Caps the harness consumes. Structurally a subset of `ResolvedCliKnobs`, so the
 *  agent loop can pass `getCliKnobs()` straight in. */
export interface HarnessCaps {
  maxToolLoops: number;
  repeatToolSequenceLimit: number;
  stormThreshold: number;
  agentMcpToolBudget: number;
  maxSpawnDepth: number;
}

export interface ResolvedHarnessCaps extends HarnessCaps {
  /** True when the local-model profile is clamping (vs a passthrough of `base`). */
  active: boolean;
}

/** Ceilings applied to a local model (L1). Each is a MAX, never a floor. */
const LOCAL_CEILINGS: HarnessCaps = {
  maxToolLoops: 24,
  repeatToolSequenceLimit: 6,
  stormThreshold: 3,
  agentMcpToolBudget: 8,
  maxSpawnDepth: 2,
};

/**
 * Resolve the effective harness caps for `model` under `mode`:
 *  - `off`  → passthrough of `base` (no clamping, ever).
 *  - `on`   → always clamp.
 *  - `auto` → clamp only for a positively-identified local family.
 * Clamping takes `min(base, ceiling)` per cap, so a user's already-tighter setting
 * is never loosened.
 */
export function resolveLocalModelProfile(
  model: string | undefined,
  mode: LocalModelProfileMode,
  base: HarnessCaps,
): ResolvedHarnessCaps {
  const active = localModelProfileActive(model, mode);
  if (!active) return { active: false, ...base };
  return {
    active: true,
    maxToolLoops: Math.min(base.maxToolLoops, LOCAL_CEILINGS.maxToolLoops),
    repeatToolSequenceLimit: Math.min(base.repeatToolSequenceLimit, LOCAL_CEILINGS.repeatToolSequenceLimit),
    stormThreshold: Math.min(base.stormThreshold, LOCAL_CEILINGS.stormThreshold),
    agentMcpToolBudget: Math.min(base.agentMcpToolBudget, LOCAL_CEILINGS.agentMcpToolBudget),
    maxSpawnDepth: Math.min(base.maxSpawnDepth, LOCAL_CEILINGS.maxSpawnDepth),
  };
}
