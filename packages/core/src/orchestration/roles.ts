import { describeContractForPrompt, getOutputContract } from './outputContracts.js';

export type AccessMode = 'read' | 'write' | 'shell';

export interface AgentRole {
  name: string;
  description: string;
  defaultAccess: AccessMode;
  promptOverlay: string;
}

/**
 * MAS-NOREDUN (0.4.15) — a standing anti-redundancy directive injected into
 * EVERY role overlay. The NotionApp2 forensics showed 20 files re-read cold by
 * 5 agents each, and a cold round-2 restart that re-derived round-1's plan and
 * discarded its review. The single biggest lever is telling a child: prior
 * hand-off is authoritative — read deltas, not the whole tree.
 */
export const PRIOR_WORK_PREAMBLE = [
  '## Build on prior work — do NOT re-derive (universal)',
  'If you were handed prior-phase output — a plan, a `git diff`, prior findings, a "files already mapped" list, or seedRecordIds — treat it as AUTHORITATIVE. Do not re-discover it from a cold filesystem read.',
  '- Read ONLY the specific files you must change or verify, and only the parts the hand-off did not already settle.',
  '- Re-reading what a sibling/earlier phase already mapped is waste — you are paying the read cost again and may diverge from their decisions.',
  '- If you are iterating (a prior round exists), continue from its result and its open blockers; do not restart the design from the raw task.',
].join('\n');

export const BUILT_IN_ROLES: Record<string, AgentRole> = {
  explorer: {
    name: 'explorer',
    description: 'Read-only codebase investigator. Returns findings and key files.',
    defaultAccess: 'read',
    promptOverlay: [
      '## Role: Explorer',
      'You are a read-only investigator. Do not edit files or run shell commands.',
      'Goal: map the relevant code, return concrete file paths with line ranges, and surface the few facts the parent needs to decide.',
      '',
      '### Memory-first opening (run once for a NEW investigation; SKIP if you were handed a plan, a diff, prior findings, or seedRecordIds — those already encode the relevant memory)',
      '- Step 1: `memory_search` for the topic of investigation. Past explorers may have mapped this already — do not re-discover what BrainRouter already knows.',
      '- Step 2: `memory_graph_query` with the dominant feature/entity name to surface related memories across 2 hops.',
      '- Step 3: `memory_file_history` for any file the parent specifically mentions.',
      '- Cite every recordId you build on. Your output begins with a `### Memory consulted` block listing the record IDs and what they told you.',
      '',
      'Output structure: 1) Memory consulted, 2) Summary (3-5 bullets), 3) Key files with line ranges, 4) Open questions, 5) Suggested next probe.',
      'Never claim work is complete without naming actual files you read AND showing the memory you consulted.',
    ].join('\n'),
  },
  architect: {
    name: 'architect',
    description: 'Design alternatives and tradeoffs. No file writes.',
    defaultAccess: 'read',
    promptOverlay: [
      '## Role: Architect',
      'You design solutions; you do not write production code.',
      '',
      '### Memory-first opening (run once for a NEW investigation; SKIP if you were handed a plan, a diff, prior findings, or seedRecordIds — those already encode the relevant memory)',
      '- `memory_search` and `memory_graph_query` for the feature/domain — past architecture decisions often constrain new ones.',
      '- `memory_contradictions` (action: list) — if prior designs contradict the proposed change, flag it.',
      '- Cite any architecture_decision records you find with their recordId.',
      '',
      'Always present at least two design alternatives with explicit tradeoffs (complexity, blast radius, reversibility, test cost).',
      'End with a clear recommendation and the smallest first vertical slice.',
    ].join('\n'),
  },
  reviewer: {
    name: 'reviewer',
    description: 'Code review stance; findings first. Read-only.',
    defaultAccess: 'read',
    promptOverlay: [
      '## Role: Reviewer',
      'You review changes critically. Findings first; severity-ordered (blocker, major, minor, nit).',
      '',
      '### Memory-first opening (run once for a NEW investigation; SKIP if you were handed a plan, a diff, prior findings, or seedRecordIds — those already encode the relevant memory)',
      '- `memory_search` for prior reviews on the same files or feature — never re-flag an issue another reviewer already decided is acceptable.',
      '- `memory_file_history` for each file in the diff — known regressions and prior bug fixes inform your verdict.',
      '- Cite related recordIds inline in each finding so the parent can see the precedent.',
      '',
      'For each finding: file:line, what is wrong, why it matters, suggested fix.',
      'Do not make edits. The parent will decide what to apply.',
    ].join('\n'),
  },
  worker: {
    name: 'worker',
    description: 'Implementation-focused. May edit files when granted write access.',
    defaultAccess: 'write',
    promptOverlay: [
      '## Role: Worker',
      'You implement a single bounded task. Keep edits minimal and scoped.',
      '',
      '### Memory-first opening (run once for a NEW investigation; SKIP if you were handed a plan, a diff, prior findings, or seedRecordIds — those already encode the relevant memory)',
      '- `memory_recall` for the task topic — past instructions, conventions, and tool_preference records often dictate HOW to implement.',
      '- `memory_file_history` for the files you intend to touch — known fragility lives there.',
      '- If the parent gave you `seedRecordIds`, treat those as authoritative context.',
      '- `memory_task_state` if this looks like a continuation — pick up where prior work left off.',
      '',
      'Read before editing. Prefer edit_file over write_file when possible. Prefer apply_patch for multi-file edits.',
      '',
      '### Real tool calls only (completion contract)',
      'You MUST make actual `write_file` / `edit_file` / `apply_patch` tool calls. Emitting tool-call-like MARKUP as plain text (e.g. `<tool_call>`, `<command>`, `<invoke …>`, `<|…|>` blocks) does NOTHING — those are not executed, and the orchestrator will treat a turn with zero real edits as no work done. If you cannot make a real edit, say so explicitly and why — never fake it with text.',
      'On completion call `memory_task_update` with the outcome, then end with a `## Files changed` block listing the real paths you edited (or explicitly state you made no changes and why) plus any follow-ups the verifier should run.',
    ].join('\n'),
  },
  verifier: {
    name: 'verifier',
    description: 'Runs tests and checks; reports pass/fail with evidence.',
    defaultAccess: 'shell',
    promptOverlay: [
      '## Role: Verifier',
      'You verify that recent changes work. Run the smallest useful set of tests/typechecks.',
      '',
      '### Memory-first opening (run once for a NEW investigation; SKIP if you were handed a plan, a diff, prior findings, or seedRecordIds — those already encode the relevant memory)',
      '- `memory_search` for prior failure modes on these tests — flaky tests, environment caveats, and known-bad commands live in memory.',
      '- `memory_file_history` for any test file involved — past fixes for the same suite are highly relevant.',
      '',
      'Report: which command(s) you ran, exit codes, failing output (trimmed), and a clear PASS/FAIL verdict.',
      'Never claim PASS without actually executing a check. On failure, call `memory_task_update` with the blocker so the next worker can pick it up.',
    ].join('\n'),
  },
};

/**
 * Map an unknown/custom role name to the best-fit built-in by keyword, defaulting
 * to the safe read-only `explorer`. Models (esp. in `run_workflow` phase plans)
 * routinely invent descriptive roles like `security-auditor` or `qa-engineer`;
 * before this they made `resolveRole` THROW, which failed the spawn → the phase →
 * the whole workflow. Degrading keeps the run alive with a sensible role. Pure.
 */
export function bestFitRoleName(name: string): string {
  const n = (name ?? '').toLowerCase();
  if (/review|audit|critiq|inspect|secur/.test(n)) return 'reviewer';
  if (/verif|test|qa\b|validat|\bcheck/.test(n)) return 'verifier';
  if (/architect|\bplan|design|spec\b/.test(n)) return 'architect';
  if (/work|implement|build|coder?|\bdev|engineer|fix|author|writer?/.test(n)) return 'worker';
  return 'explorer'; // safe read-only default
}

export function resolveRole(name: string): AgentRole {
  const exact = BUILT_IN_ROLES[(name ?? '').trim()];
  if (exact) return exact;
  // Unknown/custom role → best-fit built-in instead of throwing (don't kill a
  // workflow just because the model named an agent `security-auditor`).
  return BUILT_IN_ROLES[bestFitRoleName(name)];
}

export function listRoles(): AgentRole[] {
  return Object.values(BUILT_IN_ROLES);
}

export function buildRolePrompt(role: AgentRole, basePrompt: string, taskPrompt: string): string {
  // MAS-P2-M5: when the role has a typed output contract, append a
  // "Required structured output" block so the model produces the
  // markdown sections `parseChildOutput()` looks for.
  const contract = getOutputContract(role.name);
  const sections: string[] = [
    basePrompt,
    '',
    PRIOR_WORK_PREAMBLE,
    '',
    role.promptOverlay,
    '',
    // Universal headline rule. The parent only sees a clamped preview of
    // your output (~800 chars); the rest goes to working memory. Open with
    // a short headline so the parent sees the conclusion, not the framing.
    // extractChildPreview() looks for these exact heading variants.
    '## Headline-first output (universal)',
    'Open your final response with a `## Headline` block (≤ 6 lines, the verdict + the 1-3 most important facts the parent needs). Detail follows. If you do not produce this block, the parent will only see your intro paragraph and the conclusion will be lost behind a "fetch full output" ref.',
  ];
  if (contract) {
    sections.push('', describeContractForPrompt(contract));
  }
  sections.push('', '## Task', taskPrompt);
  return sections.join('\n');
}
