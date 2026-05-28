/**
 * MAS-P2-M3 — `ParentExecutionContextSnapshot`.
 *
 * The typed contract a parent agent hands to every child it spawns.
 * Captures *only references* to memory (recordIds) and short excerpts
 * of mutable state (plan, briefing) — the brain stays the single
 * source of truth for memory bodies. A child needing deeper context
 * calls MCP (`memory_recall`, `memory_file_history`, etc.) rather
 * than reading copy-pasted state from the snapshot.
 *
 * The snapshot is also the federation Stage 4 handoff packet — same
 * structure flies over the wire when one CLI delegates work to a
 * sibling. Treating "spawn a local child" and "delegate to a remote
 * peer" as one data shape lets us avoid inventing two parallel
 * context types.
 *
 * Lifecycle:
 *
 *   1. `buildParentExecutionContextSnapshot(...)` is called from
 *      `handleSpawn` after the role + access mode are resolved.
 *   2. The snapshot is persisted on the `ChildSessionRecord` so
 *      `/agents show <id>` can render it post-hoc.
 *   3. The snapshot is also appended as the FIRST transcript entry
 *      of the child (role: `system`, name: `parent_context`,
 *      content: JSON snapshot). That way a `/transcript <id>` dump
 *      always opens with the context the parent intended.
 */

import { createHash } from 'node:crypto';
import type { AccessMode } from './roles.js';

export interface ParentExecutionContextSnapshot {
  /** UUID of the parent session that spawned this child. */
  parentSessionKey: string;
  /** UUID of the child session about to run. */
  childSessionKey: string;
  /** Role / agent definition id the parent chose for the child. */
  parentAgentId: string;
  /** OTEL trace context so spans nest under the dispatching tool. */
  trace?: { traceId: string; spanId: string };
  /** Active goal text + status. Undefined when no goal is set. */
  goal?: { text: string; status: string };
  /** Excerpt of the parent's `/plan`. First ~600 chars; full plan stays on disk. */
  planExcerpt?: string;
  /** Memory record ids the parent's briefing surfaced. References, not bodies. */
  recalledRecordIds?: string[];
  /** Excerpt of the parent's last memory briefing. First ~500 chars. */
  briefingExcerpt?: string;
  /** Tool names exposed to the child (after access-mode and toolScope filtering). */
  visibleTools?: string[];
  /** Resolved access mode after parent → role → arg clamping. */
  accessMode: AccessMode;
  /** Workspace review policy at spawn time (`request` / `proceed`). */
  reviewPolicy?: string;
  /** Workspace execution mode at spawn time (`planning` / `fast`). */
  executionMode?: string;
  /** SHA-256 prefix of AGENT.md (or equivalent) so a stale snapshot is detectable. */
  workspaceInstructionsHash?: string;
  /** Optional ownership constraint passed by the parent (file glob, module, responsibility). */
  ownership?: string | null;
  /** Token caps the parent agreed to spend on this child. */
  tokenBudget?: { promptCap: number; completionCap: number };
  /** Output contract id (matches `outputContracts.ts` ids). */
  outputContract?: string | null;
}

const PLAN_EXCERPT_CHARS = 600;
const BRIEFING_EXCERPT_CHARS = 500;
const INSTRUCTIONS_HASH_PREFIX = 16;

export interface BuildParentSnapshotInputs {
  parentSessionKey: string;
  childSessionKey: string;
  parentAgentId: string;
  accessMode: AccessMode;
  trace?: { traceId: string; spanId: string };
  goal?: { text: string; status: string } | null | undefined;
  planText?: string | null;
  recalledRecordIds?: string[] | null;
  briefingBlock?: string | null;
  visibleTools?: string[];
  reviewPolicy?: string;
  executionMode?: string;
  workspaceInstructions?: string | null;
  ownership?: string | null;
  tokenBudget?: { promptCap: number; completionCap: number };
  outputContract?: string | null;
}

/**
 * Build a snapshot from parent runtime state. Inputs are all
 * optional-ish: missing data simply omits that field rather than
 * fabricating one. The persistent `ChildSessionRecord` only gets
 * what the parent actually knew at spawn time.
 */
export function buildParentExecutionContextSnapshot(
  inputs: BuildParentSnapshotInputs,
): ParentExecutionContextSnapshot {
  const snapshot: ParentExecutionContextSnapshot = {
    parentSessionKey: inputs.parentSessionKey,
    childSessionKey: inputs.childSessionKey,
    parentAgentId: inputs.parentAgentId,
    accessMode: inputs.accessMode,
  };
  if (inputs.trace) snapshot.trace = inputs.trace;
  if (inputs.goal && inputs.goal.text) {
    snapshot.goal = { text: inputs.goal.text, status: inputs.goal.status };
  }
  if (inputs.planText && inputs.planText.trim()) {
    snapshot.planExcerpt = truncate(inputs.planText.trim(), PLAN_EXCERPT_CHARS);
  }
  if (inputs.recalledRecordIds && inputs.recalledRecordIds.length > 0) {
    snapshot.recalledRecordIds = dedupe(inputs.recalledRecordIds).slice(0, 50);
  }
  if (inputs.briefingBlock && inputs.briefingBlock.trim()) {
    snapshot.briefingExcerpt = truncate(inputs.briefingBlock.trim(), BRIEFING_EXCERPT_CHARS);
  }
  if (inputs.visibleTools && inputs.visibleTools.length > 0) {
    snapshot.visibleTools = inputs.visibleTools.slice(0, 80);
  }
  if (inputs.reviewPolicy) snapshot.reviewPolicy = inputs.reviewPolicy;
  if (inputs.executionMode) snapshot.executionMode = inputs.executionMode;
  if (inputs.workspaceInstructions && inputs.workspaceInstructions.trim()) {
    snapshot.workspaceInstructionsHash = createHash('sha256')
      .update(inputs.workspaceInstructions)
      .digest('hex')
      .slice(0, INSTRUCTIONS_HASH_PREFIX);
  }
  if (inputs.ownership !== undefined) snapshot.ownership = inputs.ownership;
  if (inputs.tokenBudget) snapshot.tokenBudget = inputs.tokenBudget;
  if (inputs.outputContract !== undefined) snapshot.outputContract = inputs.outputContract;
  return snapshot;
}

/**
 * Render a snapshot as a human-readable block for `/agents show <id>`.
 * Field-by-field, with `—` for absent values; readable in a terminal
 * without ANSI tricks (the caller can colorize headings if it wants).
 */
export function formatSnapshotForHuman(snapshot: ParentExecutionContextSnapshot): string {
  const lines: string[] = ['Parent execution context:'];
  const row = (label: string, value: string | undefined | null): void => {
    lines.push(`  ${label.padEnd(22)} ${value ?? '—'}`);
  };
  row('parentSessionKey', snapshot.parentSessionKey);
  row('childSessionKey', snapshot.childSessionKey);
  row('parentAgentId', snapshot.parentAgentId);
  row('accessMode', snapshot.accessMode);
  row('executionMode', snapshot.executionMode);
  row('reviewPolicy', snapshot.reviewPolicy);
  if (snapshot.trace) {
    row('trace.traceId', snapshot.trace.traceId);
    row('trace.spanId', snapshot.trace.spanId);
  }
  if (snapshot.goal) {
    row('goal.status', snapshot.goal.status);
    row('goal.text', truncate(snapshot.goal.text, 120));
  } else {
    row('goal', '—');
  }
  row('planExcerpt', snapshot.planExcerpt ? `${snapshot.planExcerpt.length} chars` : '—');
  row(
    'recalledRecordIds',
    snapshot.recalledRecordIds && snapshot.recalledRecordIds.length > 0
      ? `${snapshot.recalledRecordIds.length} ids: ${snapshot.recalledRecordIds.slice(0, 3).join(', ')}${snapshot.recalledRecordIds.length > 3 ? '…' : ''}`
      : '—',
  );
  row('briefingExcerpt', snapshot.briefingExcerpt ? `${snapshot.briefingExcerpt.length} chars` : '—');
  row(
    'visibleTools',
    snapshot.visibleTools && snapshot.visibleTools.length > 0
      ? `${snapshot.visibleTools.length} tools`
      : '—',
  );
  row('workspaceInstructionsHash', snapshot.workspaceInstructionsHash);
  row('ownership', snapshot.ownership ?? '—');
  row(
    'tokenBudget',
    snapshot.tokenBudget
      ? `prompt ≤ ${snapshot.tokenBudget.promptCap.toLocaleString()}, completion ≤ ${snapshot.tokenBudget.completionCap.toLocaleString()}`
      : '—',
  );
  row('outputContract', snapshot.outputContract ?? '—');
  return lines.join('\n');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
