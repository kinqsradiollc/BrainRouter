/**
 * Registered, deterministic task-signal detection for orchestration profiles.
 *
 * Signals only select among already validated strategies. They never grant a
 * role, skill, tool, or access mode, and an ambiguous task safely produces no
 * signal so the resolver uses the profile's primary-only fallback.
 */
import { ORCHESTRATION_ACTIVATION_SIGNAL_IDS } from './orchestrationProfileCatalog.js';
import { isWorkspaceInitializationRequest } from '../../workspace/projectIntent.js';

const SIGNAL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['architecture-design', /\b(?:architecture|architectural|system design|design decision|adr)\b/i],
  ['academic-paper', /\b(?:academic paper|research paper|manuscript|journal article)\b/i],
  ['bug-fix', /\b(?:bug|defect|regression|broken|fails?|error)\b/i],
  ['citation-review', /\b(?:citation|citations|bibliograph|reference audit|source audit)\b/i],
  ['critique', /\b(?:critique|editorial review|review this draft|feedback on this draft)\b/i],
  ['dataset-audit', /\b(?:dataset audit|data quality|schema audit|data leakage|missing values)\b/i],
  ['evidence-collection', /\b(?:research|collect evidence|find sources|source-backed|literature review)\b/i],
  ['experiment', /\b(?:experiment|ab test|hypothesis test|model evaluation)\b/i],
  ['implementation', /\b(?:implement|build|add feature|change the code|code this)\b/i],
  ['investigation', /\b(?:investigate|diagnose|root cause|trace why|analy[sz]e the issue)\b/i],
  ['learning-assessment', /\b(?:quiz|assessment|test my understanding|learning objective)\b/i],
  ['multi-surface-change', /\b(?:across (?:the )?(?:cli|desktop|backend|frontend)|multi-surface|end-to-end)\b/i],
  ['question-decomposition', /\b(?:decompose (?:the )?question|research questions?|subquestions?)\b/i],
  ['remediation', /\b(?:remediate|fix the findings|resolve vulnerabilities|address review findings)\b/i],
  ['reproducibility-check', /\b(?:reproducib|replicate|methodology check|verify the results)\b/i],
  ['review', /\b(?:code review|security review|review the changes|review this pr)\b/i],
  // Overlaps `review` on purpose: a security review fires BOTH signals, and the
  // strategy order in the plan file is what decides which lens gets the task.
  ['security-review', /\b(?:security review|security audit|threat model|vulnerabilit(?:y|ies) (?:review|audit|sweep))\b/i],
  ['small-scope', /\b(?:small change|quick fix|one[- ]file|single[- ]file|minor adjustment)\b/i],
  ['source-explanation', /\b(?:explain (?:this )?(?:source|paper|chapter|concept)|teach me|walk me through)\b/i],
  ['writing-revision', /\b(?:revise|rewrite|edit (?:this )?(?:draft|article|document)|improve (?:this )?writing)\b/i],
];

export function detectOrchestrationTaskSignals(task: string): ReadonlySet<string> {
  const bounded = task.trim().slice(0, 16_000);
  const workspaceInitialization = isWorkspaceInitializationRequest(bounded);
  const detected = new Set<string>();
  for (const [id, pattern] of SIGNAL_PATTERNS) {
    if (id === 'evidence-collection' && workspaceInitialization) continue;
    if (ORCHESTRATION_ACTIVATION_SIGNAL_IDS.has(id) && pattern.test(bounded)) {
      detected.add(id);
    }
  }
  return detected;
}
