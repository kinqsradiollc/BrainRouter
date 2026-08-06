/**
 * WF-TEMPLATES (0.4.8) — built-in multi-phase `PhasePlan` builders for the
 * common shapes, so a caller doesn't have to hand-author a plan:
 *
 *   - `compare`      — analyze each option in parallel → recommend.
 *   - `review-wide`  — review each target in parallel → merge findings → summarize.
 *   - `research`     — research each angle in parallel → synthesize an answer.
 *   - `build`        — plan → implement → verify → multi-lens review.
 *   - `investigate`  — multi-lens inspection → synthesis → adversarial challenge.
 *
 * Pure: each builder returns a `PhasePlan` (or validation errors); `run_workflow`
 * (workflowTool.ts) accepts `{ template, templateArgs }` and runs the built plan
 * through the same `normalizePhasePlan` → `executePhasePlan` path as an explicit
 * plan. The user's "review each repo → synthesize" maps directly to `review-wide`.
 */

import type { PhasePlan } from '../../orchestration/workflow/phasePlan.js';
import { adversarialLens, investigationLenses, reviewLenses } from '../../orchestration/lenses.js';

export interface TemplateResult {
  plan: PhasePlan | null;
  errors: string[];
}

export const WORKFLOW_TEMPLATES = ['compare', 'review-wide', 'research', 'build', 'investigate'] as const;
export type WorkflowTemplateName = (typeof WORKFLOW_TEMPLATES)[number];

/** Distinct review lenses the single-slice `build` fans out over (parallel,
 *  read-only) so one task gets multi-angle review instead of one generalist.
 *  Now sourced from the shared lens vocabulary so the tool descriptions, the
 *  turn guards and this template cannot drift into naming different angles. */
const BUILD_REVIEW_LENSES: string[] = [...reviewLenses()];

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
}

/** `compare` — one analyst per target (parallel), then an architect recommends. */
function compareTemplate(args: Record<string, unknown>): TemplateResult {
  const targets = stringArray(args.targets);
  if (targets.length < 2) return { plan: null, errors: ['compare: `targets` must be an array of ≥2 strings'] };
  const criteria = str(args.criteria, 'strengths, weaknesses, and fit');
  const goal = str(args.goal, 'recommend the best option with clear rationale');
  return {
    plan: {
      title: `compare ${targets.join(' vs ')}`,
      phases: [
        {
          id: 'analyze',
          title: 'Analyze each option',
          fanOut: {
            over: targets,
            agent: {
              role: 'explorer',
              access: 'read',
              prompt: `Analyze "{{target}}" on: ${criteria}. Be concrete and cite evidence. Output a tight summary of {{target}}'s ${criteria}.`,
            },
          },
          synthesize: 'role-rollup',
        },
        {
          id: 'recommend',
          title: 'Compare & recommend',
          agents: [
            {
              role: 'architect',
              access: 'read',
              prompt: `You are comparing: ${targets.join(', ')}. Per-option analyses:\n\n{{input}}\n\nNow ${goal}.`,
            },
          ],
          inputFrom: ['analyze'],
          dependsOn: ['analyze'],
        },
      ],
    },
    errors: [],
  };
}

/** `review-wide` — one reviewer per target (parallel) → merge findings → summarize. */
function reviewWideTemplate(args: Record<string, unknown>): TemplateResult {
  const paths = stringArray(args.paths ?? args.targets);
  if (paths.length < 1) return { plan: null, errors: ['review-wide: `paths` must be an array of ≥1 strings'] };
  const focus = str(args.focus, 'correctness, security, and clarity');
  return {
    plan: {
      title: `review ${paths.length} target(s)`,
      phases: [
        {
          id: 'review',
          title: 'Review each target',
          fanOut: {
            over: paths,
            agent: {
              role: 'reviewer',
              access: 'read',
              prompt: `Review "{{target}}" for ${focus}. After a brief prose summary, output a JSON array of findings so they can be merged: [{"file":"path","line":<number|null>,"severity":"high|medium|low","confidence":0-100,"summary":"..."}]. Return [] if it's clean.`,
            },
          },
          synthesize: 'review-merge',
        },
        {
          id: 'summarize',
          title: 'Summarize findings',
          agents: [
            {
              role: 'architect',
              access: 'read',
              prompt: `Consolidate these per-target review findings into one prioritized summary (highest-severity first):\n\n{{input}}`,
            },
          ],
          inputFrom: ['review'],
          dependsOn: ['review'],
        },
      ],
    },
    errors: [],
  };
}

/** `research` — one researcher per angle (parallel) → synthesize an answer. */
function researchTemplate(args: Record<string, unknown>): TemplateResult {
  const question = str(args.question);
  if (!question) return { plan: null, errors: ['research: `question` (non-empty string) is required'] };
  const angles = stringArray(args.angles);
  const over = angles.length > 0 ? angles : ['background & definitions', 'current state & evidence', 'risks & counterarguments'];
  return {
    plan: {
      title: `research: ${question.slice(0, 40)}`,
      phases: [
        {
          id: 'gather',
          title: 'Research each angle',
          fanOut: {
            over,
            agent: {
              role: 'explorer',
              access: 'read',
              prompt: `Research the "{{target}}" angle of this question: "${question}". Gather concrete findings and cite sources.`,
            },
          },
          synthesize: 'role-rollup',
        },
        {
          id: 'synthesize',
          title: 'Synthesize answer',
          agents: [
            {
              role: 'architect',
              access: 'read',
              prompt: `Synthesize a well-supported answer to: "${question}".\n\nFindings by angle:\n\n{{input}}`,
            },
          ],
          inputFrom: ['gather'],
          dependsOn: ['gather'],
        },
      ],
    },
    errors: [],
  };
}

/**
 * `investigate` — the read-only high-effort shape: N distinct lenses in parallel
 * → architect synthesis → ONE adversary briefed to break that synthesis.
 *
 * The adversary is the point. `research` already fans out and synthesizes, and
 * stops there — nothing ever attacks the answer, so a confidently-wrong
 * synthesis reaches the user with the authority of N children behind it. Here
 * the challenge phase consumes the synthesis via `inputFrom` and is briefed to
 * falsify it; the parent answers the challenge rather than merging it.
 */
function investigateTemplate(args: Record<string, unknown>): TemplateResult {
  const question = str(args.question);
  if (!question) return { plan: null, errors: ['investigate: `question` (non-empty string) is required'] };
  const requested = stringArray(args.lenses);
  const over = requested.length > 0 ? requested : [...investigationLenses()];
  if (over.length < 2) return { plan: null, errors: ['investigate: `lenses` must name ≥2 distinct angles — one lens is not an investigation'] };
  return {
    plan: {
      title: `investigate: ${question.slice(0, 40)}`,
      phases: [
        {
          id: 'inspect',
          title: 'Inspect through each lens',
          fanOut: {
            over,
            agent: {
              role: 'explorer',
              access: 'read',
              prompt: `Question: "${question}"\n\nInvestigate ONLY through the "{{target}}" lens — ignore anything outside it, and say "nothing for this lens" rather than padding. Cite concrete evidence (file paths, line numbers, command output) for every claim; mark anything you inferred but did not verify as UNVERIFIED.`,
            },
          },
          synthesize: 'role-rollup',
        },
        {
          id: 'synthesize',
          title: 'Synthesize a conclusion',
          agents: [
            {
              role: 'architect',
              access: 'read',
              prompt: `Synthesize one evidence-backed conclusion for: "${question}".\n\nState what is established, what is still unknown, and which claims rest on UNVERIFIED evidence.\n\nFindings by lens:\n\n{{input}}`,
            },
          ],
          inputFrom: ['inspect'],
          dependsOn: ['inspect'],
        },
        {
          id: 'challenge',
          title: 'Adversarial challenge',
          agents: [
            {
              role: 'reviewer',
              access: 'read',
              prompt: `Question under investigation: "${question}"\n\nYour job is to ${adversarialLens()}. Do NOT review style or restate agreement. Verify the cited evidence yourself — read the files, run the greps — and report: (a) claims the evidence does not support, (b) contradicting evidence, (c) what was never checked. If it survives, say so and name the strongest remaining risk.\n\nSynthesis to attack:\n\n{{input}}`,
            },
          ],
          inputFrom: ['synthesize'],
          dependsOn: ['synthesize'],
        },
      ],
    },
    errors: [],
  };
}

/**
 * `build` (0.4.12 P1) — the engineering loop for ONE task: plan → implement →
 * verify → review, run through the existing phase engine. The worker (Implement)
 * gets the 0.4.11 isolated worktree + merge-back on clean completion.
 *
 * P1 NOTE: Verify + Review run as their own children (review reads the worker's
 * reported changes via {{input}}). Making Verify run the tests against the
 * worker's EXACT pre-merge tree — and gating the merge on verify-green /
 * review-ok — is P2 (the phase-scoped shared worktree). Until then this ships
 * the visible, runnable pipeline structure.
 */
function buildTemplate(args: Record<string, unknown>): TemplateResult {
  const task = str(args.task ?? args.goal ?? args.prompt);
  if (!task) return { plan: null, errors: ['build: `task` (non-empty string) is required'] };

  // BUILD-LOOP P2.5 — FAN-OUT build: >1 independent slices → one worker per slice,
  // each in its OWN held worktree, then a cross-worktree SYNTHESIS review over the
  // combined change-set before the gated merge (`finalizeFanOutBuild`). The merge
  // gate is structural (overlap-aware) + the reviewer's blocker verdict; per-slice
  // test-run verify is deferred (slices aren't applied until the gated merge).
  const slices = stringArray(args.slices);
  if (slices.length > 1) {
    return {
      plan: {
        title: `build (fan-out ×${slices.length}): ${task.slice(0, 40)}`,
        phases: [
          {
            id: 'plan',
            title: 'Plan',
            agents: [{
              role: 'architect',
              access: 'read',
              prompt: `Task: ${task}\n\nThe work is split into ${slices.length} INDEPENDENT slices:\n${slices.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nProduce a SHORT shared plan + per-slice guidance so the slices stay consistent (shared naming/contracts, no duplicated work, no two slices editing the same file). No code yet.`,
            }],
          },
          {
            id: 'implement',
            title: 'Implement',
            fanOut: {
              over: slices,
              agent: {
                role: 'worker',
                access: 'write',
                prompt: `Overall task: ${task}\n\nShared plan:\n\n{{input}}\n\nYOUR slice ONLY: {{target}}\n\nImplement just your slice. Keep edits minimal and scoped to your slice's own files — do NOT touch files another slice owns. Report exactly which files you changed.`,
              },
            },
            inputFrom: ['plan'],
            dependsOn: ['plan'],
          },
          {
            id: 'review',
            title: 'Synthesis review',
            agents: [{
              role: 'reviewer',
              access: 'read',
              prompt: `Task: ${task}\n\nThe parallel slices each implemented part of it. Review the COMBINED change-set — run \`git diff HEAD\` to see the actual merged edits (the per-slice prose below is for intent only). Look for cross-slice problems a per-slice review can't see: two slices editing the same file, inconsistent contracts/naming between slices, duplicated work, or gaps between slices. Findings-first, severity-ordered (blocker / major / minor / nit). Say "blocker" if any slice must NOT merge as-is.\n\nPer-slice self-reports (cross-reference only):\n\n{{input}}`,
            }],
            inputFrom: ['implement'],
            dependsOn: ['implement'],
          },
        ],
      },
      errors: [],
    };
  }

  return {
    plan: {
      title: `build: ${task.slice(0, 48)}`,
      phases: [
        {
          id: 'plan',
          title: 'Plan',
          agents: [{
            role: 'architect',
            access: 'read',
            prompt: `Task: ${task}\n\nProduce a SHORT implementation plan: the files to touch, the approach, and the smallest first vertical slice. No code yet — just the plan the worker will follow.`,
          }],
        },
        {
          id: 'implement',
          title: 'Implement',
          agents: [{
            role: 'worker',
            access: 'write',
            prompt: `Task: ${task}\n\nPlan to follow:\n\n{{input}}\n\nImplement it. Keep edits minimal and scoped. Report exactly which files you changed and anything the verifier should run.`,
          }],
          inputFrom: ['plan'],
          dependsOn: ['plan'],
        },
        {
          id: 'verify',
          title: 'Verify',
          agents: [{
            role: 'verifier',
            access: 'shell',
            // MAS-GROUNDTRUTH (B1): inspect the REAL change-set, not the worker's
            // self-report. The worker's edits are in this worktree, so `git diff`
            // is ground truth — the prose may be incomplete or (for weak models)
            // corrupted. If installs fail with a network/ENOTFOUND error the
            // sandbox is OFFLINE — do NOT retry installs; verify what runs offline.
            prompt: `Task: ${task}\n\nThe worker's changes are in your current worktree. Run \`git diff HEAD\` (and \`git status\`) to see the EXACT change-set — do NOT rely on the prose summary below. Then run the smallest useful build + typecheck/test set and report a clear PASS / FAIL / BLOCKED-ENVIRONMENT with evidence (commands, exit codes, trimmed failing output). If a dependency install fails with a network error (ENOTFOUND / offline), report BLOCKED-ENVIRONMENT immediately and verify only what runs without network — never retry the install.\n\nWorker's self-report (cross-reference only, may be incomplete):\n\n{{input}}`,
          }],
          inputFrom: ['implement'],
          dependsOn: ['implement'],
        },
        {
          // Fan out the review across independent LENSES (read-only, so they
          // run safely in parallel) → more thorough coverage than one reviewer,
          // then role-rollup merges the lens findings.
          id: 'review',
          title: 'Review',
          fanOut: {
            over: BUILD_REVIEW_LENSES,
            agent: {
              role: 'reviewer',
              access: 'read',
              // B1: review the REAL diff from the worktree, not the worker's prose.
              prompt: `Task: ${task}\n\nThe worker's changes are in your current worktree — run \`git diff HEAD\` to review the EXACT change-set (the prose self-report below may be incomplete or corrupted; use it only for intent). Review ONLY through the "{{target}}" lens — ignore issues outside it. Findings-first, severity-ordered (blocker / major / minor / nit); say "none for this lens" if clean.\n\nWorker's self-report (cross-reference only):\n\n{{input}}`,
            },
          },
          synthesize: 'role-rollup',
          inputFrom: ['implement'],
          dependsOn: ['implement'],
        },
      ],
    },
    errors: [],
  };
}

/** Build a `PhasePlan` from a named template + its args. */
export function buildTemplatePlan(name: string, args: unknown): TemplateResult {
  const a = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  switch (name) {
    case 'compare':
      return compareTemplate(a);
    case 'review-wide':
      return reviewWideTemplate(a);
    case 'research':
      return researchTemplate(a);
    case 'build':
      return buildTemplate(a);
    case 'investigate':
      return investigateTemplate(a);
    default:
      return { plan: null, errors: [`unknown template "${name}". Known: ${WORKFLOW_TEMPLATES.join(', ')}`] };
  }
}
