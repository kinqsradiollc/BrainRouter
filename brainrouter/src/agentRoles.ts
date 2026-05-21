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
      'Output structure: 1) Summary (3-5 bullets), 2) Key files with line ranges, 3) Open questions, 4) Suggested next probe.',
      'Never claim work is complete without naming actual files you read.',
    ].join('\n'),
  },
  architect: {
    name: 'architect',
    description: 'Design alternatives and tradeoffs. No file writes.',
    defaultAccess: 'read',
    promptOverlay: [
      '## Role: Architect',
      'You design solutions; you do not write production code.',
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
      'Read before editing. Prefer edit_file over write_file when possible.',
      'Report exactly which files you changed and any follow-ups the verifier should run.',
    ].join('\n'),
  },
  verifier: {
    name: 'verifier',
    description: 'Runs tests and checks; reports pass/fail with evidence.',
    defaultAccess: 'shell',
    promptOverlay: [
      '## Role: Verifier',
      'You verify that recent changes work. Run the smallest useful set of tests/typechecks.',
      'Report: which command(s) you ran, exit codes, failing output (trimmed), and a clear PASS/FAIL verdict.',
      'Never claim PASS without actually executing a check.',
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
  return [
    basePrompt,
    '',
    role.promptOverlay,
    '',
    '## Task',
    taskPrompt,
  ].join('\n');
}
