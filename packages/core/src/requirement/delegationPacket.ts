/**
 * HONK-H2 — turn a structured requirement into a SELF-CONTAINED executor handoff.
 *
 * The intake agent (and, later, the Track "Run with agent" action) disambiguates a
 * vague ask into a `RequirementRecord`, then hands it to a fresh executor agent.
 * For the executor to run from the packet ALONE — no back-references to the intake
 * conversation — the handoff must carry the full spec: the title, description,
 * acceptance criteria, and the decisions settled during clarification. This module
 * renders exactly that, deterministically (so it's testable and identical whether
 * the agent or a host action drives the handoff).
 */
import type { RequirementRecord } from '@kinqs/brainrouter-types';

export interface DelegationPacket {
  requirementId: string;
  title: string;
  /** A complete, self-contained prompt the executor runs with no other context. */
  executorPrompt: string;
  acceptanceCriteria: string[];
  /** Memory records intake already recalled — pass as `seedRecordIds` so the
   *  executor doesn't re-discover them cold. */
  seedRecordIds: string[];
}

/**
 * Whether a requirement is complete enough to hand off: it needs a title, at least
 * one acceptance criterion to verify against, and no still-open clarifying
 * questions. Returns the specific gaps so the intake agent knows what to resolve.
 */
export function requirementReadyForHandoff(req: RequirementRecord): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!req.title?.trim()) missing.push('a title');
  if (!req.acceptanceCriteria?.some((c) => c.trim())) missing.push('at least one acceptance criterion');
  const open = (req.clarifyingQuestions ?? []).filter((q) => q.question?.trim() && !q.answer?.trim());
  if (open.length) missing.push(`${open.length} unanswered clarifying question(s)`);
  return { ready: missing.length === 0, missing };
}

/**
 * Render a self-contained executor handoff from a requirement. Pure — same record
 * in → same packet out. `opts.extraContext` appends caller-supplied context (e.g.
 * a Track item link) without breaking the self-contained contract.
 */
export function buildDelegationPacket(req: RequirementRecord, opts?: { extraContext?: string }): DelegationPacket {
  const title = (req.title ?? '').trim() || 'Untitled requirement';
  const criteria = (req.acceptanceCriteria ?? []).map((c) => c.trim()).filter(Boolean);
  const decided = (req.clarifyingQuestions ?? []).filter((q) => q.question?.trim() && q.answer?.trim());

  const lines: string[] = [
    'You are implementing a self-contained requirement. This packet is your COMPLETE spec —',
    'do NOT ask for clarification or reference any prior conversation; everything you need is below.',
    '',
    `# ${title}`,
  ];
  if (req.description?.trim()) lines.push('', req.description.trim());

  lines.push('', '## Acceptance criteria (your work is DONE only when ALL pass)');
  if (criteria.length) criteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  else lines.push('_(none specified — infer the smallest verifiable definition of done and state it in your result)_');

  if (decided.length) {
    lines.push('', '## Decisions already settled during intake (do not relitigate)');
    for (const q of decided) lines.push(`- Q: ${q.question.trim()} → A: ${q.answer!.trim()}`);
  }

  if (opts?.extraContext?.trim()) lines.push('', '## Additional context', opts.extraContext.trim());

  lines.push(
    '',
    '## How to finish',
    '- Implement the change so every acceptance criterion above is satisfied.',
    "- Run the project's verify (tests / typecheck / lint) and confirm it is green.",
    '- Deliver your work as a reviewable PR with a focused, self-explanatory diff.',
    `- Requirement id (for traceability): ${req.id}.`,
  );

  return {
    requirementId: req.id,
    title,
    executorPrompt: lines.join('\n'),
    acceptanceCriteria: criteria,
    seedRecordIds: [...(req.linkedMemoryIds ?? [])],
  };
}
