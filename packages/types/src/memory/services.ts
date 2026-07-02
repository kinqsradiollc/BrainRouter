/**
 * BrainRouter Memory Types — service configs, skill/user records, LLM runner.
 *
 * Split out of the original `memory.ts` god file; re-exported from the
 * `../memory.js` barrel so the public surface is unchanged.
 */

// ============================
// Services
// ============================

export interface EmbeddingServiceConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
}

export interface RerankerServiceConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  topN?: number;
  timeoutMs?: number;
}

export interface RelevanceJudgeServiceConfig {
  /** Enable flag — when false, the judge stage is skipped entirely. */
  enabled?: boolean;
  /** OpenAI-compatible chat-completions endpoint. Falls back to BRAINROUTER_LLM_ENDPOINT. */
  endpoint?: string;
  /** API key. Falls back to BRAINROUTER_LLM_API_KEY. */
  apiKey?: string;
  /** Model id for the judge. Defaults to a fast/cheap model. */
  model?: string;
  /** Max candidates sent to the judge in a single batched call. Default 10. */
  maxCandidates?: number;
  /** Per-call timeout in ms. Default 15000. */
  timeoutMs?: number;
}

export interface SkillHintsRecord {
  skillName: string;
  hints: string;
  sourceFile: string;
  registeredAt: string;
}

export interface SkillActivationRecord {
  skillName: string;
  potential: number;
  lastDecayTime: string;
}

export interface UserRecord {
  userId: string;
  apiKey: string;
  passwordHash: string | null;
  displayName: string;
  email: string;
  isAdmin: boolean;
  status: "active" | "disabled";
  createdAt: string;
}

export interface PublicUserRecord {
  userId: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  status: "active" | "disabled";
  createdAt: string;
}

// ============================
// LLM Runner
// ============================

/**
 * A function/tool the model is FORCED to call so its output is shape-constrained
 * by a schema rather than by a "respond in JSON" prompt instruction — which
 * keeps parsing consistent across model versions. `parameters` is a JSON Schema
 * (must be an object at the top level, per the OpenAI tool contract). Keep it
 * LOOSE (constrain the wrapper shape, not every field) so the model still emits
 * the full content the prompt asks for.
 */
export interface LLMToolSchema {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface LLMRunParams {
  prompt: string;
  systemPrompt?: string;
  taskId: string;
  timeoutMs?: number;
  /**
   * When set, the runner sends this as a forced `tool_choice` and returns the
   * tool-call's JSON `arguments` string. Backends without tool-calling support
   * fall back transparently to a plain completion (the prompt should still carry
   * the JSON instruction as the fallback). Either way the returned string is run
   * through the JSON chokepoint by the caller.
   */
  tool?: LLMToolSchema;
}

export interface LLMRunner {
  run(params: LLMRunParams): Promise<string>;
}
