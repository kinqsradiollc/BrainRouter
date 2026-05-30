import type { MemoryTaskIntent, MemoryType } from "@kinqs/brainrouter-types";

export interface TypeConfig {
  halfLifeDays: number | null;
  defaultConfidence: number;
  requiresEvidence: boolean;
  intentAffinity: Partial<Record<MemoryTaskIntent, number>>;
  /**
   * 0.4.3 — cap on this type's NORMALIZED priority contribution (0–1) during
   * recall ranking. Generic, long-lived "context" types (instruction never
   * decays; architecture_decision has a 180-day half-life) otherwise accrue a
   * near-ceiling priority term that structurally out-ranks fresh, on-topic
   * findings (bug_finding, security_policy) regardless of query relevance —
   * the "5× 'BrainRouter is an autonomous agent' dominates every recall"
   * pathology. Undefined = no cap (the default for task-specific types).
   */
  recallPriorityCap?: number;
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
  instruction: { halfLifeDays: null, defaultConfidence: 0.85, requiresEvidence: false, intentAffinity: {}, recallPriorityCap: 0.5 },
  skill_context: { halfLifeDays: 7, defaultConfidence: 0.65, requiresEvidence: false, intentAffinity: {} },
  tool_preference: { halfLifeDays: 90, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: { build: 1.05 } },
  codebase_fact: { halfLifeDays: 60, defaultConfidence: 0.65, requiresEvidence: false, intentAffinity: { build: 1.15, refactor: 1.1 } },
  api_contract: { halfLifeDays: 90, defaultConfidence: 0.75, requiresEvidence: true, intentAffinity: { review: 1.2, security: 1.15, build: 1.1 } },
  data_model: { halfLifeDays: 90, defaultConfidence: 0.75, requiresEvidence: true, intentAffinity: { review: 1.2, security: 1.15, build: 1.1 } },
  dependency_constraint: { halfLifeDays: 120, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { build: 1.1, refactor: 1.1 } },
  environment_constraint: { halfLifeDays: 120, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { build: 1.1, debug: 1.1 } },
  architecture_decision: { halfLifeDays: 180, defaultConfidence: 0.8, requiresEvidence: false, intentAffinity: { build: 1.2, plan: 1.15, refactor: 1.1 }, recallPriorityCap: 0.5 },
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
  task_state: { halfLifeDays: 14, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { plan: 1.3, build: 1.1 }, recallPriorityCap: 0.6 },
  handover_note: { halfLifeDays: 21, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { plan: 1.25, build: 1.1 } },
  blocked_reason: { halfLifeDays: 21, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { plan: 1.2, debug: 1.1 } },
  review_comment: { halfLifeDays: 45, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: { review: 1.3 } },
  release_note: { halfLifeDays: 90, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: { release: 1.3 } },
  source_evidence: { halfLifeDays: 120, defaultConfidence: 0.8, requiresEvidence: false, intentAffinity: { review: 1.1, security: 1.1 } },
  artifact_reference: { halfLifeDays: 90, defaultConfidence: 0.7, requiresEvidence: false, intentAffinity: { plan: 1.1, build: 1.1 } },
  file_history: { halfLifeDays: 90, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { debug: 1.15, refactor: 1.2, review: 1.1 } },
  command_knowledge: { halfLifeDays: 90, defaultConfidence: 0.75, requiresEvidence: false, intentAffinity: { debug: 1.2, performance: 1.15, test: 1.1 } },
  // MEM-32 — durable, corroboration-reinforced lessons/insights. No decay (a
  // lesson re-confirmed across sessions only strengthens), evidence-backed, and
  // broadly recall-favorable so it surfaces in briefings.
  lesson: { halfLifeDays: null, defaultConfidence: 0.8, requiresEvidence: true, intentAffinity: { plan: 1.2, build: 1.15, debug: 1.2, review: 1.15, refactor: 1.1 } },
};

export function getMemoryTypeConfig(type: string): TypeConfig {
  return TYPE_CONFIGS[type as MemoryType] ?? DEFAULT_TYPE_CONFIG;
}

export function detectTaskIntent(query: string): MemoryTaskIntent {
  const q = query.toLowerCase();
  // debug stays first — active error-chasing ("debug the auth crash") wants
  // bug_finding/debug_trace even when it's security-adjacent.
  if (/\b(debug|bug|error|fail|failing|failure|repro|crash|stack|traceback|exception|panic|segfault)\b/.test(q)) return "debug";
  // security is checked SECOND (ahead of review/audit) and with broad,
  // plural-aware vocabulary. Before 0.4.3 it sat after `refactor` and only
  // matched the singular "vulnerability", so "find all the VULNERABILITIES in
  // our api" fell through to `build` — which boosts architecture/instruction
  // boilerplate over the security findings the query is actually about. A
  // "security audit" must also beat the generic `audit`→review branch.
  if (/\b(security|secure|insecure|auth|authn|authz|authentication|authorization|permission|rbac|oauth|jwt|sso|secret|secrets|credential|credentials|vulnerab(?:ility|ilities|le)|cve|exploit(?:able|ed|s)?|leak(?:age|ed|s|ing)?|inject(?:ion|ed)?|sqli|xss|csrf|ssrf|idor|\brce\b|unauth(?:enticated|orized)?|privilege|escalat\w*|sanitiz\w*|exposure|exposed|breach|attacker|malicious)\b/.test(q)) return "security";
  if (/\b(review|audit|risk|regression|pr|pull request|code review|lgtm|approve)\b/.test(q)) return "review";
  if (/\b(test|spec|coverage|vitest|jest|benchmark result|assertion|expect|describe|it\()\b/.test(q)) return "test";
  if (/\b(plan|task|roadmap|todo|handover|blocked|next|sprint|milestone|backlog)\b/.test(q)) return "plan";
  if (/\b(refactor|cleanup|simplify|migration|deprecate|rename|extract|move|reorganize|restructure)\b/.test(q)) return "refactor";
  if (/\b(performance|latency|throughput|slow|benchmark|r@5|token savings|optimize|cache|memory leak|profil|bottleneck)\b/.test(q)) return "performance";
  if (/\b(release|ship|launch|deploy|changelog|version|tag|publish|hotfix)\b/.test(q)) return "release";
  return "build";
}

export function extractFilePathHints(text: string): string[] {
  const matches = text.match(/(?:[\w.-]+\/)+[\w.-]+\.\w+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|sql|py|go|rs)/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/^["'`]|["'`]$/g, "")))];
}
