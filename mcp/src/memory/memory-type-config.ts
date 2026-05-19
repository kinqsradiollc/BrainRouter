import type { MemoryTaskIntent, MemoryType } from "@brainrouter/types";

export interface TypeConfig {
  halfLifeDays: number | null;
  defaultConfidence: number;
  requiresEvidence: boolean;
  intentAffinity: Partial<Record<MemoryTaskIntent, number>>;
}

const DEFAULT_TYPE_CONFIG: TypeConfig = {
  halfLifeDays: 30,
  defaultConfidence: 0.65,
  requiresEvidence: false,
  intentAffinity: {},
};

export const TYPE_CONFIGS: Record<MemoryType, TypeConfig> = {
  persona: { halfLifeDays: 180, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: {} },
  episodic: { halfLifeDays: 30, defaultConfidence: 0.65, requiresEvidence: false, intentAffinity: {} },
  instruction: { halfLifeDays: null, defaultConfidence: 0.85, requiresEvidence: false, intentAffinity: {} },
  skill_context: { halfLifeDays: 7, defaultConfidence: 0.65, requiresEvidence: false, intentAffinity: {} },
  tool_preference: { halfLifeDays: 90, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: { build: 1.05 } },
  codebase_fact: { halfLifeDays: 60, defaultConfidence: 0.65, requiresEvidence: false, intentAffinity: { build: 1.15, refactor: 1.1 } },
  api_contract: { halfLifeDays: 90, defaultConfidence: 0.75, requiresEvidence: true, intentAffinity: { review: 1.2, security: 1.15, build: 1.1 } },
  data_model: { halfLifeDays: 90, defaultConfidence: 0.75, requiresEvidence: true, intentAffinity: { review: 1.2, security: 1.15, build: 1.1 } },
  dependency_constraint: { halfLifeDays: 120, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { build: 1.1, refactor: 1.1 } },
  environment_constraint: { halfLifeDays: 120, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { build: 1.1, debug: 1.1 } },
  architecture_decision: { halfLifeDays: 180, defaultConfidence: 0.8, requiresEvidence: false, intentAffinity: { build: 1.2, plan: 1.15, refactor: 1.1 } },
  implementation_decision: { halfLifeDays: 90, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { build: 1.2, refactor: 1.1 } },
  design_constraint: { halfLifeDays: 120, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { build: 1.1, review: 1.1 } },
  security_policy: { halfLifeDays: 180, defaultConfidence: 0.8, requiresEvidence: true, intentAffinity: { security: 1.3, review: 1.2 } },
  performance_baseline: { halfLifeDays: 45, defaultConfidence: 0.75, requiresEvidence: true, intentAffinity: { performance: 1.3, review: 1.1 } },
  bug_finding: { halfLifeDays: 45, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: { debug: 1.3, review: 1.1 } },
  debug_trace: { halfLifeDays: 30, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: { debug: 1.3 } },
  fix_summary: { halfLifeDays: 60, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { debug: 1.15, build: 1.1 } },
  verification_result: { halfLifeDays: 45, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { test: 1.25, performance: 1.15, debug: 1.1 } },
  failed_attempt: { halfLifeDays: 45, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: { debug: 1.25 } },
  regression_risk: { halfLifeDays: 90, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { review: 1.25, test: 1.15 } },
  task_state: { halfLifeDays: 14, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { plan: 1.3, build: 1.1 } },
  handover_note: { halfLifeDays: 21, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { plan: 1.25, build: 1.1 } },
  blocked_reason: { halfLifeDays: 21, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { plan: 1.2, debug: 1.1 } },
  review_comment: { halfLifeDays: 45, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: { review: 1.3 } },
  release_note: { halfLifeDays: 90, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: { release: 1.3 } },
  source_evidence: { halfLifeDays: 120, defaultConfidence: 0.8, requiresEvidence: false, intentAffinity: { review: 1.1, security: 1.1 } },
  artifact_reference: { halfLifeDays: 90, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: { plan: 1.1, build: 1.1 } },
  file_history: { halfLifeDays: 90, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { debug: 1.15, refactor: 1.2, review: 1.1 } },
  command_knowledge: { halfLifeDays: 90, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { debug: 1.2, performance: 1.15, test: 1.1 } },
};

export function getMemoryTypeConfig(type: string): TypeConfig {
  return TYPE_CONFIGS[type as MemoryType] ?? DEFAULT_TYPE_CONFIG;
}

export function detectTaskIntent(query: string): MemoryTaskIntent {
  const q = query.toLowerCase();
  if (/\b(debug|bug|error|fail|failing|failure|repro|crash|stack)\b/.test(q)) return "debug";
  if (/\b(review|audit|risk|regression|pr|pull request)\b/.test(q)) return "review";
  if (/\b(test|spec|coverage|vitest|benchmark result)\b/.test(q)) return "test";
  if (/\b(plan|task|roadmap|todo|handover|blocked|next)\b/.test(q)) return "plan";
  if (/\b(refactor|cleanup|simplify|migration|deprecate)\b/.test(q)) return "refactor";
  if (/\b(security|auth|permission|secret|token|vulnerability)\b/.test(q)) return "security";
  if (/\b(performance|latency|throughput|slow|benchmark|r@5|token savings)\b/.test(q)) return "performance";
  if (/\b(release|ship|launch|deploy|changelog)\b/.test(q)) return "release";
  return "build";
}

export function extractFilePathHints(text: string): string[] {
  const matches = text.match(/(?:[\w.-]+\/)+[\w.-]+\.\w+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|sql|py|go|rs)/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/^["'`]|["'`]$/g, "")))];
}
