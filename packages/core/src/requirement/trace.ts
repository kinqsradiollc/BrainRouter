/**
 * REQUIREMENT SDD TRACE (0.4.16) — the `(covers: R-n)` coverage layer.
 *
 * A single load-bearing convention: every actionable plan step may end with a
 * `(covers: R-1, R-3)` tag naming the requirement(s) it addresses. From that one
 * tag we derive everything downstream — per-requirement coverage, the set of
 * still-uncovered requirements, and a FORWARD-ONLY coverage status advanced from
 * plan-step completion (`draft → planned → building → done → verified`).
 *
 * This is a pure, dependency-light module (no fs, no store imports) deliberately
 * decoupled from BOTH input shapes so the same engine serves two callers:
 *   1. our structured stores — `RequirementRecord[]` + `PlanState`, via the
 *      `traceModelFromRecords` adapter below; and
 *   2. an on-disk `requirement.md` doc — `### R-n: title {status}` blocks with
 *      `- [ ]` acceptance checkboxes, via `parseRequirementBlocks`.
 *
 * The forward-only COVERAGE status here (`TraceStatus`) is intentionally its own
 * vocabulary, separate from the requirement lifecycle `RequirementStatus`
 * (draft/clarifying/ready/…): one tracks *implementation progress derived from
 * the plan*, the other is the human-owned lifecycle. We never overwrite the
 * lifecycle from the trace; a UI may surface both.
 *
 * Style mirrors `task/planHistoryStore.ts` (pure snapshot + diff functions).
 */

import type { RequirementRecord } from '@kinqs/brainrouter-types';
import type { PlanState } from '../task/taskStore.js';

// ---------------------------------------------------------------------------
// Normalized model (format-agnostic — fed from records OR markdown)
// ---------------------------------------------------------------------------

/** A single acceptance criterion and whether it is currently satisfied. */
export interface TraceCriterion {
  text: string;
  done: boolean;
}

/** A requirement as the trace engine sees it: an id, a title, and criteria. */
export interface TraceRequirement {
  /** `R-1` (markdown) or `req_<hex>` (our store) — matched verbatim against covers tags. */
  id: string;
  title: string;
  criteria: TraceCriterion[];
  /** A `{status}` annotation parsed from a markdown heading, if present (advisory only). */
  declaredStatus?: string;
}

/** Coverage-relevant view of one plan step. */
export interface TracePlanStep {
  /** Step text with any trailing `(covers: …)` tag stripped. */
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Requirement ids this step covers (explicit tag, or the plan anchor fallback). */
  covers: string[];
}

/**
 * Forward-only coverage status. Ordered lattice: a requirement only ever
 * advances along this chain, never regresses (see {@link advanceTraceStatus}).
 */
export type TraceStatus = 'draft' | 'planned' | 'building' | 'done' | 'verified';

const TRACE_STATUS_ORDER: readonly TraceStatus[] = [
  'draft',
  'planned',
  'building',
  'done',
  'verified',
];

/** Narrow an unknown to a {@link TraceStatus}. */
export function isTraceStatus(x: unknown): x is TraceStatus {
  return typeof x === 'string' && (TRACE_STATUS_ORDER as readonly string[]).includes(x);
}

/**
 * Forward-only advance: returns `next` only if it is at or beyond `prev` in the
 * lattice, otherwise keeps `prev`. This is the "never downgraded" guarantee —
 * a requirement that reached `building` stays there even if a later plan edit
 * momentarily looks like `planned`.
 */
export function advanceTraceStatus(prev: TraceStatus, next: TraceStatus): TraceStatus {
  return TRACE_STATUS_ORDER.indexOf(next) >= TRACE_STATUS_ORDER.indexOf(prev) ? next : prev;
}

// ---------------------------------------------------------------------------
// covers-tag parsing
// ---------------------------------------------------------------------------

// `(covers: R-1, R-3)` / `(covers R-1)` / `(covers: req_ab12cd34)`. The id token
// is permissive (`R-1`, `req_…`, or any word-ish id) so both id schemes work.
const COVERS_TAG = /\(\s*covers\s*:?\s*([^)]*)\)/i;
const ID_TOKEN = /[A-Za-z][\w-]*/g;

/**
 * Extract the requirement ids from a step's `(covers: …)` tag. Returns a
 * de-duplicated, order-preserving list; `[]` when there is no tag. Tolerates
 * `covers:`/`covers`, comma/space separators, and mixed id schemes.
 */
export function parseCoversTags(text: string): string[] {
  const m = COVERS_TAG.exec(text);
  if (!m) return [];
  const ids = m[1].match(ID_TOKEN) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Remove a trailing/inline `(covers: …)` tag, returning clean display text. */
export function stripCoversTags(text: string): string {
  return text.replace(COVERS_TAG, '').replace(/\s{2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// markdown requirement.md parsing (`### R-n: title {status}` + `- [ ]` criteria)
// ---------------------------------------------------------------------------

const REQ_HEADING = /^#{1,6}\s+(R-\d+)\s*:\s*(.+?)\s*$/;
const STATUS_SUFFIX = /\s*\{([^}]*)\}\s*$/;
const CRITERION_LINE = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;

/**
 * Parse an on-disk `requirement.md` into {@link TraceRequirement}s. Each
 * `### R-n: <title> {status}` heading opens a block; `- [ ] / - [x]` lines in
 * the block body become criteria; a trailing `{status}` on the heading is
 * captured as `declaredStatus` (advisory — the trace derives status itself).
 */
export function parseRequirementBlocks(markdown: string): TraceRequirement[] {
  const out: TraceRequirement[] = [];
  let current: TraceRequirement | null = null;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const heading = REQ_HEADING.exec(rawLine);
    if (heading) {
      if (current) out.push(current);
      let title = heading[2];
      let declaredStatus: string | undefined;
      const statusMatch = STATUS_SUFFIX.exec(title);
      if (statusMatch) {
        declaredStatus = statusMatch[1].trim() || undefined;
        title = title.replace(STATUS_SUFFIX, '').trim();
      }
      current = { id: heading[1], title, criteria: [], declaredStatus };
      continue;
    }
    if (!current) continue;
    const crit = CRITERION_LINE.exec(rawLine);
    if (crit) {
      current.criteria.push({ text: crit[2].trim(), done: crit[1].toLowerCase() === 'x' });
    }
  }
  if (current) out.push(current);
  return out;
}

// ---------------------------------------------------------------------------
// coverage + forward-only status derivation
// ---------------------------------------------------------------------------

export interface RequirementCoverage {
  id: string;
  title: string;
  /** At least one plan step names this requirement in its covers tag. */
  covered: boolean;
  /** Display texts of the steps covering this requirement. */
  coveringSteps: string[];
  /** Covered AND every covering step is completed. */
  done: boolean;
  criteriaTotal: number;
  criteriaDone: number;
  /** Forward-only candidate status derived from coverage + completion. */
  status: TraceStatus;
}

export interface CoverageReport {
  requirements: RequirementCoverage[];
  /** Requirement ids with no covering plan step. */
  uncovered: string[];
  /** covered / total, rounded to a whole percent (0 when there are no requirements). */
  coveragePct: number;
  total: number;
  coveredCount: number;
}

/**
 * Derive the forward-only coverage status for one requirement from the plan
 * steps that cover it:
 *   - no covering step                       → `draft`
 *   - covering steps, all pending            → `planned`
 *   - some in_progress / partially completed → `building`
 *   - every covering step completed          → `done`
 *   - …and all acceptance criteria satisfied → `verified`
 * `verified` requires ≥1 criterion (a criteria-less requirement caps at `done`).
 */
export function deriveTraceStatus(
  requirement: TraceRequirement,
  coveringSteps: TracePlanStep[],
): TraceStatus {
  if (coveringSteps.length === 0) return 'draft';
  const allCompleted = coveringSteps.every((s) => s.status === 'completed');
  if (allCompleted) {
    const criteria = requirement.criteria;
    const allCriteriaDone = criteria.length > 0 && criteria.every((c) => c.done);
    return allCriteriaDone ? 'verified' : 'done';
  }
  const anyStarted = coveringSteps.some(
    (s) => s.status === 'in_progress' || s.status === 'completed',
  );
  return anyStarted ? 'building' : 'planned';
}

/**
 * Compute coverage for a set of requirements against a set of plan steps. Pure:
 * a requirement is "covered" when ≥1 step lists its id in `covers`.
 */
export function computeCoverage(
  requirements: TraceRequirement[],
  steps: TracePlanStep[],
): CoverageReport {
  const out: RequirementCoverage[] = requirements.map((req) => {
    const coveringSteps = steps.filter((s) => s.covers.includes(req.id));
    const covered = coveringSteps.length > 0;
    const done = covered && coveringSteps.every((s) => s.status === 'completed');
    const criteriaDone = req.criteria.filter((c) => c.done).length;
    return {
      id: req.id,
      title: req.title,
      covered,
      coveringSteps: coveringSteps.map((s) => s.step),
      done,
      criteriaTotal: req.criteria.length,
      criteriaDone,
      status: deriveTraceStatus(req, coveringSteps),
    };
  });
  const coveredCount = out.filter((r) => r.covered).length;
  const total = out.length;
  return {
    requirements: out,
    uncovered: out.filter((r) => !r.covered).map((r) => r.id),
    coveragePct: total === 0 ? 0 : Math.round((coveredCount / total) * 100),
    total,
    coveredCount,
  };
}

// ---------------------------------------------------------------------------
// drift detection — FNV-1a per-block hashing + snapshot diff
// ---------------------------------------------------------------------------

/**
 * 32-bit FNV-1a over whitespace-normalized text → 8-char hex. Same hash family
 * as the content hashes in `@kinqs/brainrouter-types`; kept local so the trace
 * module stays dependency-light and self-contained.
 */
function hashBlock(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Stable content hash of a requirement (title + each criterion + its done flag). */
export function hashRequirement(req: TraceRequirement): string {
  const payload = [req.title, ...req.criteria.map((c) => `${c.done ? 'x' : ' '}:${c.text}`)].join('\n');
  return hashBlock(payload);
}

export interface TraceSnapshot {
  version: 1;
  /** requirement id → content hash, captured at plan-generation time. */
  blocks: Record<string, string>;
}

export interface TraceDrift {
  /** Present in both snapshots, hash differs (the requirement was edited). */
  changedIds: string[];
  /** Present only in the newer snapshot. */
  addedIds: string[];
  /** Present only in the older snapshot. */
  removedIds: string[];
  /** Any of the above is non-empty — the plan may be stale. */
  stale: boolean;
}

/** Snapshot the content hashes of every requirement for later drift detection. */
export function snapshotTrace(requirements: TraceRequirement[]): TraceSnapshot {
  const blocks: Record<string, string> = {};
  for (const req of requirements) blocks[req.id] = hashRequirement(req);
  return { version: 1, blocks };
}

/**
 * Diff two trace snapshots by requirement id (mirrors planHistoryStore's
 * `diffSnapshots`): which requirements changed content, were added, or removed
 * since the plan was generated.
 */
export function diffTrace(before: TraceSnapshot, after: TraceSnapshot): TraceDrift {
  const changedIds: string[] = [];
  const addedIds: string[] = [];
  const removedIds: string[] = [];
  for (const [id, hash] of Object.entries(after.blocks)) {
    if (!(id in before.blocks)) addedIds.push(id);
    else if (before.blocks[id] !== hash) changedIds.push(id);
  }
  for (const id of Object.keys(before.blocks)) {
    if (!(id in after.blocks)) removedIds.push(id);
  }
  return {
    changedIds,
    addedIds,
    removedIds,
    stale: changedIds.length > 0 || addedIds.length > 0 || removedIds.length > 0,
  };
}

// ---------------------------------------------------------------------------
// adapter: our structured stores → the normalized trace model
// ---------------------------------------------------------------------------

export interface TraceModel {
  requirements: TraceRequirement[];
  steps: TracePlanStep[];
}

/** One `RequirementRecord` → a `TraceRequirement` (criteria start un-ticked). */
export function traceRequirementFromRecord(record: RequirementRecord): TraceRequirement {
  return {
    id: record.id,
    title: record.title,
    criteria: record.acceptanceCriteria.map((text) => ({ text, done: false })),
  };
}

/**
 * Project a `PlanState` into coverage-relevant steps. A step's covers list is
 * its explicit `(covers: …)` tag when present; otherwise it falls back to the
 * plan's single `requirementId` anchor — so our existing one-requirement plans
 * get coverage for free, while multi-requirement plans can opt into the richer
 * Kun-style tagging.
 */
export function tracePlanStepsFromPlan(plan: PlanState): TracePlanStep[] {
  return plan.items.map((item) => {
    const explicit = parseCoversTags(item.step);
    const covers = explicit.length > 0 ? explicit : plan.requirementId ? [plan.requirementId] : [];
    return { step: stripCoversTags(item.step), status: item.status, covers };
  });
}

/** Build the full trace model from our records + the active plan. */
export function traceModelFromRecords(records: RequirementRecord[], plan: PlanState): TraceModel {
  return {
    requirements: records.map(traceRequirementFromRecord),
    steps: tracePlanStepsFromPlan(plan),
  };
}
