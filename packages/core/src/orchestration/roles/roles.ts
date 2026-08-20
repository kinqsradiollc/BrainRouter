import { describeContractForPrompt, getOutputContract } from './outputContracts.js';
import {
  domainNeutralRolePrompt,
  type ActiveProfilePromptContext,
} from './rolePromptSelection.js';
import { presetAccess, type CapabilityPresetName } from './capabilityPresets.js';

export type { ActiveProfilePromptContext } from './rolePromptSelection.js';
export { CAPABILITY_PRESETS, presetAccess, type CapabilityPreset, type CapabilityPresetName } from './capabilityPresets.js';

export type AccessMode = 'read' | 'write' | 'shell';

export interface AgentRole {
  name: string;
  description: string;
  /**
   * ADR-041 A41-9 — the capability preset this built-in role consumes.
   * `defaultAccess` (and `forceSandbox`) are DERIVED from it via `presetAccess()`,
   * so the access tier is named once in `capabilityPresets.ts` rather than
   * restated per role. Optional: a dynamically-built role (a spawn/continuation
   * with a bespoke access grant) sets `defaultAccess` directly and omits this.
   */
  preset?: CapabilityPresetName;
  defaultAccess: AccessMode;
  promptOverlay: string;
  /**
   * HONK-H0 — a fleet/background executor role. When true, a child spawned in
   * this role runs with the OS sandbox + network-deny + secret-env scrubbing
   * FORCED on, un-opt-out-able by `cli.sandboxEnforceWhenSilent`. For unattended
   * fleet runs where no human is watching the blast radius. Derived from the
   * role's preset (`sandboxed-executor`).
   */
  forceSandbox?: boolean;
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
    preset: 'readonly',
    ...presetAccess('readonly'),
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
    preset: 'readonly',
    ...presetAccess('readonly'),
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
    preset: 'readonly',
    ...presetAccess('readonly'),
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
    preset: 'implementer',
    ...presetAccess('implementer'),
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
    preset: 'executor',
    ...presetAccess('executor'),
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
  fleet: {
    name: 'fleet',
    description: 'Unattended fleet executor. Implements a self-contained task end-to-end in an isolated, sandboxed worktree; its work is delivered as a PR.',
    preset: 'sandboxed-executor',
    ...presetAccess('sandboxed-executor'),
    promptOverlay: [
      '## Role: Fleet executor (unattended)',
      'You run UNATTENDED — no human will approve or notice a risky step. You execute one self-contained task end-to-end in an isolated git worktree.',
      'Your environment is locked down: the OS sandbox is ON and outbound network is DENIED; secret-shaped env vars are scrubbed from your shell as a best-effort layer. Do NOT attempt to reach the network or read host credentials (e.g. ~/.aws, the CLI config, .env files) — if the task genuinely needs an external resource, state that in your result instead of working around it.',
      '',
      '### Memory-first opening (run once for a NEW task; SKIP if you were handed a plan, a diff, prior findings, or seedRecordIds)',
      '- `memory_search` for prior work on this task/area — past attempts, blockers, and environment caveats live in memory.',
      '',
      'Work from your handed-off requirement/packet alone. Make the change, run the project\'s verify (tests/typecheck/lint), and report a clear PASS/FAIL with evidence. Your changes are delivered as a reviewable PR — keep the diff focused and self-explanatory.',
    ].join('\n'),
  },
  intake: {
    name: 'intake',
    description: 'Requirements intake. Turns a vague ask into a structured requirement, then hands a self-contained packet to an executor.',
    preset: 'readonly',
    ...presetAccess('readonly'),
    promptOverlay: [
      '## Role: Requirements intake',
      'You turn a vague ask into a precise, self-contained unit of work, then hand it off to an executor. You do NOT implement — your job is to make the next agent able to run with zero back-references.',
      '',
      '### Memory-first opening (run once; SKIP if you were handed prior findings or seedRecordIds)',
      '- `memory_search` for prior requirements, conventions, and decisions on this area — reuse, don\'t re-derive.',
      '',
      '### Do this, in order',
      '1. CLARIFY only what blocks a correct implementation. Ask the smallest set of questions (send them back to the requester); do not interrogate. Record each question + its answer.',
      '2. STRUCTURE the result as a requirement: a one-line title, a short description, and CONCRETE, verifiable acceptance criteria (the definition of done). Persist it (the requirement store) so it has a stable id.',
      '3. HAND OFF: once the requirement has a title and at least one acceptance criterion and no open questions, build a SELF-CONTAINED executor prompt from it — the title, description, every acceptance criterion, and the decisions you settled — and delegate it via `task_agent`/`delegate_agent` (role `worker`, or `fleet` for unattended). Pass any memory records you recalled as `seedRecordIds`. The executor must never need to read this conversation.',
      '',
      'Keep acceptance criteria testable ("X returns Y for input Z"), not aspirational. If the ask is already crisp, skip the questions and go straight to the requirement + handoff.',
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

export function resolveRole(
  name: string,
  promptContext?: ActiveProfilePromptContext,
): AgentRole {
  const exact = BUILT_IN_ROLES[(name ?? '').trim()];
  const compatibilityRole = exact ?? BUILT_IN_ROLES[bestFitRoleName(name)];
  const neutral = domainNeutralRolePrompt(compatibilityRole.name, promptContext);
  if (neutral) {
    return {
      ...compatibilityRole,
      description: neutral.description,
      promptOverlay: neutral.prompt,
    };
  }
  // Unknown/custom role → best-fit built-in instead of throwing (don't kill a
  // workflow just because the model named an agent `security-auditor`).
  return compatibilityRole;
}

export function listRoles(promptContext?: ActiveProfilePromptContext): AgentRole[] {
  return Object.keys(BUILT_IN_ROLES).map((name) => resolveRole(name, promptContext));
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
