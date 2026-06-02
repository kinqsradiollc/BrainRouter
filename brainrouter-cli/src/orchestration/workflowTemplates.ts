/**
 * WF-TEMPLATES (0.4.8) — built-in multi-phase `PhasePlan` builders for the
 * common shapes, so a caller doesn't have to hand-author a plan:
 *
 *   - `compare`      — analyze each option in parallel → recommend.
 *   - `review-wide`  — review each target in parallel → merge findings → summarize.
 *   - `research`     — research each angle in parallel → synthesize an answer.
 *
 * Pure: each builder returns a `PhasePlan` (or validation errors); `run_workflow`
 * (workflowTool.ts) accepts `{ template, templateArgs }` and runs the built plan
 * through the same `normalizePhasePlan` → `executePhasePlan` path as an explicit
 * plan. The user's "review each repo → synthesize" maps directly to `review-wide`.
 */

import type { PhasePlan } from './phasePlan.js';

export interface TemplateResult {
  plan: PhasePlan | null;
  errors: string[];
}

export const WORKFLOW_TEMPLATES = ['compare', 'review-wide', 'research'] as const;
export type WorkflowTemplateName = (typeof WORKFLOW_TEMPLATES)[number];

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
    default:
      return { plan: null, errors: [`unknown template "${name}". Known: ${WORKFLOW_TEMPLATES.join(', ')}`] };
  }
}
