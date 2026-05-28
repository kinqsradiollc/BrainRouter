import { describeContractForPrompt, getOutputContract } from './outputContracts.js';

export type AccessMode = 'read' | 'write' | 'shell';

export interface AgentRole {
  name: string;
  description: string;
  defaultAccess: AccessMode;
  promptOverlay: string;
}

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
      '### Memory-first opening (mandatory)',
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
      '### Memory-first opening (mandatory)',
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
      '### Memory-first opening (mandatory)',
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
      '### Memory-first opening (mandatory)',
      '- `memory_recall` for the task topic — past instructions, conventions, and tool_preference records often dictate HOW to implement.',
      '- `memory_file_history` for the files you intend to touch — known fragility lives there.',
      '- If the parent gave you `seedRecordIds`, treat those as authoritative context.',
      '- `memory_task_state` if this looks like a continuation — pick up where prior work left off.',
      '',
      'Read before editing. Prefer edit_file over write_file when possible. Prefer apply_patch for multi-file edits.',
      'On completion call `memory_task_update` with the outcome, then report exactly which files you changed and any follow-ups the verifier should run.',
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
      '### Memory-first opening (mandatory)',
      '- `memory_search` for prior failure modes on these tests — flaky tests, environment caveats, and known-bad commands live in memory.',
      '- `memory_file_history` for any test file involved — past fixes for the same suite are highly relevant.',
      '',
      'Report: which command(s) you ran, exit codes, failing output (trimmed), and a clear PASS/FAIL verdict.',
      'Never claim PASS without actually executing a check. On failure, call `memory_task_update` with the blocker so the next worker can pick it up.',
    ].join('\n'),
  },
};

export function resolveRole(name: string): AgentRole {
  const role = BUILT_IN_ROLES[name];
  if (!role) {
    const known = Object.keys(BUILT_IN_ROLES).join(', ');
    throw new Error(`Unknown agent role "${name}". Known roles: ${known}.`);
  }
  return role;
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
