/**
 * WF-PLAN (0.4.8) — the declarative `PhasePlan` schema for deterministic,
 * multi-phase, multi-agent workflows.
 *
 * A `PhasePlan` describes ordered phases; each phase fans out one or more child
 * agents (explicit list, or a homogeneous fan-out over a target list), an optional
 * synthesis step aggregates the phase's children, and a phase can declare it
 * consumes a prior phase's synthesized output. The RUNTIME (WF-ENGINE,
 * `phaseOrchestrator.ts`) executes this plan deterministically — it spawns every
 * child via the existing `handleSpawn` chokepoint, barrier-waits the phase, runs
 * synthesis, and feeds the result forward — so fan-out + phasing happen reliably
 * instead of depending on the model to emit the right spawn calls each turn.
 *
 * This module is PURE: schema types, a tolerant validator/normalizer, the
 * plan→spawn-list expansion, prompt-variable rendering, and dependency ordering.
 * No I/O, no spawning — that's WF-ENGINE.
 */

import type { AccessMode } from '../registry/roles.js';

/** How a phase aggregates its children's outputs before the next phase. */
export type PhaseSynthesis = 'role-rollup' | 'review-merge' | 'none';

/** One child agent in a phase. */
export interface PhaseAgentSpec {
  /** Preset role (`explorer|architect|reviewer|worker|verifier`) or omitted to
   *  auto-route from the prompt (same vocabulary as `spawn_agents`). */
  role?: string;
  /** Prompt template. May contain `{{target}}` (the fan-out item) and `{{input}}`
   *  (the synthesized output of the phases named in `inputFrom`). */
  prompt: string;
  /** `read | write | shell`. Defaults to `read`; the engine still clamps a child
   *  to ≤ the parent's access at spawn time. */
  access?: AccessMode;
  /** Optional display label (defaults to the fan-out target or the role). */
  label?: string;
}

/** One ordered phase. Has EITHER an explicit `agents` list OR a `fanOut`. */
export interface WorkflowPhase {
  id: string;
  title: string;
  /** Explicit, heterogeneous agents. Mutually exclusive with `fanOut`. */
  agents?: PhaseAgentSpec[];
  /** Homogeneous fan-out: one clone of `agent` per `over` item, with `{{target}}`
   *  substituted. Mutually exclusive with `agents`. */
  fanOut?: { over: string[]; agent: PhaseAgentSpec };
  /** Prior phase id(s) whose synthesized output is injected as `{{input}}` here. */
  inputFrom?: string[];
  /** How to aggregate this phase's children. Defaults to `none`. */
  synthesize?: PhaseSynthesis;
  /** Phase id(s) that must finish first. Defaults to declaration order. */
  dependsOn?: string[];
}

export interface PhasePlan {
  title?: string;
  phases: WorkflowPhase[];
}

export interface PhasePlanResult {
  /** The normalized plan (defaults filled), or `null` if any hard error was found. */
  plan: PhasePlan | null;
  /** All validation errors (collected — not first-only — so a bad plan reports fully). */
  errors: string[];
}

const ACCESS_MODES: readonly AccessMode[] = ['read', 'write', 'shell'];
const SYNTH_MODES: readonly PhaseSynthesis[] = ['role-rollup', 'review-merge', 'none'];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Validate + normalize a raw (e.g. JSON-parsed, model-produced) plan. Tolerant:
 * fills defaults (`access:'read'`, `synthesize:'none'`, `title` ← `id`), collects
 * ALL errors, and returns `plan:null` if any hard error is present.
 */
export function normalizePhasePlan(raw: unknown): PhasePlanResult {
  const errors: string[] = [];
  if (!isObject(raw)) return { plan: null, errors: ['plan must be an object'] };
  if (!Array.isArray(raw.phases) || raw.phases.length === 0) {
    return { plan: null, errors: ['plan.phases must be a non-empty array'] };
  }

  const seenIds = new Set<string>();
  const phases: WorkflowPhase[] = [];

  raw.phases.forEach((rawPhase, i) => {
    const where = `phases[${i}]`;
    if (!isObject(rawPhase)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const id = isNonEmptyString(rawPhase.id) ? rawPhase.id.trim() : '';
    if (!id) errors.push(`${where}.id is required (non-empty string)`);
    else if (seenIds.has(id)) errors.push(`${where}.id "${id}" is duplicated`);
    else seenIds.add(id);

    const title = isNonEmptyString(rawPhase.title) ? rawPhase.title.trim() : id;

    const hasAgents = Array.isArray(rawPhase.agents);
    const hasFanOut = isObject(rawPhase.fanOut);
    if (hasAgents === hasFanOut) {
      errors.push(`${where} ("${id || i}") must have exactly one of "agents" or "fanOut"`);
    }

    let agents: PhaseAgentSpec[] | undefined;
    let fanOut: WorkflowPhase['fanOut'];

    if (hasAgents) {
      const list = rawPhase.agents as unknown[];
      if (list.length === 0) errors.push(`${where}.agents must not be empty`);
      agents = list.map((a, j) => normalizeAgent(a, `${where}.agents[${j}]`, errors));
    }
    if (hasFanOut) {
      const fo = rawPhase.fanOut as Record<string, unknown>;
      const over = Array.isArray(fo.over) ? fo.over.filter(isNonEmptyString) : [];
      if (over.length === 0) errors.push(`${where}.fanOut.over must be a non-empty string array`);
      const agent = normalizeAgent(fo.agent, `${where}.fanOut.agent`, errors);
      fanOut = { over, agent };
    }

    let synthesize: PhaseSynthesis = 'none';
    if (rawPhase.synthesize !== undefined) {
      if (SYNTH_MODES.includes(rawPhase.synthesize as PhaseSynthesis)) {
        synthesize = rawPhase.synthesize as PhaseSynthesis;
      } else {
        errors.push(`${where}.synthesize must be one of ${SYNTH_MODES.join(' | ')}`);
      }
    }

    const inputFrom = toStringArray(rawPhase.inputFrom);
    const dependsOn = toStringArray(rawPhase.dependsOn);

    phases.push({ id: id || `phase-${i}`, title, agents, fanOut, inputFrom, synthesize, dependsOn });
  });

  // Cross-references (inputFrom / dependsOn must name real phases) + cycle check.
  const ids = new Set(phases.map((p) => p.id));
  for (const p of phases) {
    for (const ref of p.inputFrom ?? []) {
      if (!ids.has(ref)) errors.push(`phase "${p.id}".inputFrom references unknown phase "${ref}"`);
    }
    for (const ref of p.dependsOn ?? []) {
      if (!ids.has(ref)) errors.push(`phase "${p.id}".dependsOn references unknown phase "${ref}"`);
    }
  }
  if (errors.length === 0 && hasDependencyCycle(phases)) {
    errors.push('plan has a dependency cycle in dependsOn');
  }

  if (errors.length > 0) return { plan: null, errors };
  const plan: PhasePlan = { phases };
  if (isNonEmptyString(raw.title)) plan.title = raw.title.trim();
  return { plan, errors };
}

function normalizeAgent(raw: unknown, where: string, errors: string[]): PhaseAgentSpec {
  if (!isObject(raw)) {
    errors.push(`${where} must be an object`);
    return { prompt: '', access: 'read' };
  }
  if (!isNonEmptyString(raw.prompt)) errors.push(`${where}.prompt is required (non-empty string)`);
  let access: AccessMode = 'read';
  if (raw.access !== undefined) {
    if (ACCESS_MODES.includes(raw.access as AccessMode)) access = raw.access as AccessMode;
    else errors.push(`${where}.access must be one of ${ACCESS_MODES.join(' | ')}`);
  }
  const spec: PhaseAgentSpec = { prompt: isNonEmptyString(raw.prompt) ? raw.prompt : '', access };
  if (isNonEmptyString(raw.role)) spec.role = raw.role.trim();
  if (isNonEmptyString(raw.label)) spec.label = raw.label.trim();
  return spec;
}

function toStringArray(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return [];
  return v.filter(isNonEmptyString);
}

/**
 * Expand a phase into the concrete list of child agents to spawn. For `fanOut`,
 * clones the template once per target with `{{target}}` substituted; for explicit
 * `agents`, returns them as-is. Pure — WF-ENGINE calls this to get its spawn list.
 */
export function expandPhaseAgents(phase: WorkflowPhase): PhaseAgentSpec[] {
  if (phase.fanOut) {
    return phase.fanOut.over.map((target) => ({
      ...phase.fanOut!.agent,
      prompt: renderPrompt(phase.fanOut!.agent.prompt, { target }),
      label: phase.fanOut!.agent.label
        ? renderPrompt(phase.fanOut!.agent.label, { target })
        : target,
    }));
  }
  return (phase.agents ?? []).map((a) => ({ access: 'read', ...a }));
}

/** Substitute `{{target}}` / `{{input}}` placeholders in a prompt/label template. */
export function renderPrompt(template: string, vars: { target?: string; input?: string }): string {
  let out = template;
  if (vars.target !== undefined) out = out.replaceAll('{{target}}', vars.target);
  if (vars.input !== undefined) out = out.replaceAll('{{input}}', vars.input);
  return out;
}

/**
 * Linear execution order honoring `dependsOn` (topological), tie-broken by
 * declaration order. Assumes a validated (cycle-free) plan; on an unexpected
 * cycle it appends the remaining phases in declaration order rather than looping.
 */
export function phaseExecutionOrder(plan: PhasePlan): WorkflowPhase[] {
  const byId = new Map(plan.phases.map((p) => [p.id, p]));
  const done = new Set<string>();
  const order: WorkflowPhase[] = [];
  const ready = (p: WorkflowPhase) => (p.dependsOn ?? []).every((d) => !byId.has(d) || done.has(d));

  let progressed = true;
  while (order.length < plan.phases.length && progressed) {
    progressed = false;
    for (const p of plan.phases) {
      if (done.has(p.id)) continue;
      if (ready(p)) {
        order.push(p);
        done.add(p.id);
        progressed = true;
      }
    }
  }
  // Cycle / unsatisfiable deps: append the rest in declaration order (defensive).
  for (const p of plan.phases) if (!done.has(p.id)) order.push(p);
  return order;
}

/** True if `dependsOn` edges contain a cycle (used by the validator). */
export function hasDependencyCycle(phases: WorkflowPhase[]): boolean {
  const byId = new Map(phases.map((p) => [p.id, p]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    const st = state.get(id);
    if (st === 'visiting') return true;
    if (st === 'done') return false;
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep) && visit(dep)) return true;
    }
    state.set(id, 'done');
    return false;
  };
  return phases.some((p) => visit(p.id));
}

/** Total child count a phase will spawn (explicit agents, or fan-out targets). */
export function countPhaseAgents(phase: WorkflowPhase): number {
  if (phase.fanOut) return phase.fanOut.over.length;
  return phase.agents?.length ?? 0;
}
