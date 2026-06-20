/**
 * WF-LAUNCH (0.4.8) — pure helpers for the `/workflow run` launcher and the
 * `/workflows` phase-timeline view.
 *
 * The launcher validates a template + args and produces the kickoff prompt that
 * makes the agent fire ONE `run_workflow` call (the REPL runs that turn). The
 * timeline renderer turns a phase-aware run ledger (WF-PERSIST) into viewer
 * lines. Both are pure so they unit-test without the REPL/Ink runtime; the thin
 * command wiring in `workflow.ts` calls them.
 */

import { buildTemplatePlan, WORKFLOW_TEMPLATES } from '@kinqs/brainrouter-core/dist/workflow/workflowTemplates.js';
import {
  type WorkflowRun,
  phaseRunGlyph,
  summarizePhases,
  formatPhaseGlyphs,
  formatDuration,
} from '@kinqs/brainrouter-core/dist/workflow/workflowRun.js';

export type LaunchResult =
  | { ok: true; prompt: string; title: string }
  | { ok: false; error: string };

/**
 * Validate a `/workflow run <template>` request and build the agent kickoff
 * prompt. Returns an error (without launching) when the template/args are
 * invalid, so the user gets immediate feedback instead of a failed turn.
 */
export function buildWorkflowRunKickoff(template: string, templateArgs: Record<string, unknown>): LaunchResult {
  const name = (template ?? '').trim();
  if (!name) {
    return { ok: false, error: `Usage: /workflow run <template> [jsonArgs]. Templates: ${WORKFLOW_TEMPLATES.join(', ')}.` };
  }
  const built = buildTemplatePlan(name, templateArgs);
  if (!built.plan) {
    return { ok: false, error: built.errors.join('; ') };
  }
  const argsJson = JSON.stringify(templateArgs ?? {});
  const prompt = [
    `Run the "${name}" workflow now.`,
    `Make a SINGLE \`run_workflow\` tool call with template="${name}" and templateArgs=${argsJson}.`,
    `Do not spawn agents manually and do not do anything else first; after it returns, deliver the merged result.`,
  ].join(' ');
  return { ok: true, prompt, title: built.plan.title ?? name };
}

/**
 * Parse the trailing args of `/workflow run <template> ...` into a templateArgs
 * object. Accepts a JSON blob (`{"targets":["a","b"]}`) or simple
 * `key=val,val2` pairs (comma-split into arrays). Empty → `{}`.
 */
export function parseTemplateArgs(rest: string): Record<string, unknown> {
  const s = (rest ?? '').trim();
  if (!s) return {};
  if (s.startsWith('{')) {
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  // key=val[,val2,...] space-separated pairs → arrays when comma-listed.
  const out: Record<string, unknown> = {};
  for (const tok of s.split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const key = tok.slice(0, eq);
    const val = tok.slice(eq + 1);
    out[key] = val.includes(',') ? val.split(',').map((v) => v.trim()).filter(Boolean) : val;
  }
  return out;
}

/**
 * Render a phase-aware run's timeline as plain viewer lines (the caller adds
 * colour). Empty for a step-based run (no `phases`), so the caller falls back to
 * the step view.
 */
export function renderPhaseTimelineLines(run: WorkflowRun): string[] {
  const phases = run.phases ?? [];
  if (phases.length === 0) return [];
  const { done, total } = summarizePhases(run);
  const lines = [`phases: ${formatPhaseGlyphs(run)}  ${done}/${total}`];
  for (const p of phases) {
    const dur = p.startedAt ? ` (${formatDuration(p.startedAt, p.endedAt ?? run.updatedAt)})` : '';
    const kids = p.childIds.length ? ` · ${p.childIds.length} agents` : '';
    lines.push(`  ${phaseRunGlyph(p.status)} ${p.title}${kids}${dur}`);
  }
  return lines;
}
