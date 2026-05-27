/**
 * Tool-call repair pipeline (0.3.9 item 11).
 *
 * Composes the four passes:
 *
 *   1. **scavenge** — recover tool calls leaked into reasoning_content.
 *   2. **truncation** — repair truncated JSON arguments.
 *   3. **storm** — suppress identical-repeat loops.
 *
 * Schema **flatten** runs separately at tool-registration time, not
 * per-turn — see `agent/repair/flatten.ts` and the registration site
 * in `orchestration/tools.ts`.
 *
 * Adapted from openSrc/DeepSeek-Reasonix/src/repair/index.ts.
 *
 * The agent calls `ToolCallRepair.process(declaredCalls, reasoning,
 * content)` between LLM response and tool dispatch. The return shape
 * carries both the surviving call list AND a `RepairReport` the
 * tracing layer can attach to the turn's span.
 */

import { scavengeToolCalls, type ScavengedToolCall } from './scavenge.js';
import { repairTruncatedJson } from './truncation.js';
import { StormBreaker, type IsMutating, type IsStormExempt, type ToolCallLike } from './storm.js';
import { getCliKnobs } from '../../config/config.js';

export { analyzeSchema, flattenSchema, nestArguments } from './flatten.js';
export type { FlattenDecision, JSONSchema } from './flatten.js';
export { scavengeToolCalls } from './scavenge.js';
export type { ScavengeOptions, ScavengeResult, ScavengedToolCall } from './scavenge.js';
export { repairTruncatedJson, looksLikeCompleteJson } from './truncation.js';
export type { TruncationRepairResult } from './truncation.js';
export { StormBreaker } from './storm.js';
export type { ToolCallLike, IsMutating, IsStormExempt, StormVerdict } from './storm.js';

export interface RepairableToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments: string | object };
}

export interface RepairReport {
  scavenged: number;
  truncationsFixed: number;
  truncationsUnrecoverable: number;
  stormsBroken: number;
  notes: string[];
}

export interface ToolCallRepairOptions {
  allowedToolNames: ReadonlySet<string>;
  stormWindow?: number;
  stormThreshold?: number;
  maxScavenge?: number;
  isMutating?: IsMutating;
  isStormExempt?: IsStormExempt;
}

export class ToolCallRepair {
  private readonly storm: StormBreaker;
  private readonly opts: ToolCallRepairOptions;

  constructor(opts: ToolCallRepairOptions) {
    this.opts = opts;
    this.storm = new StormBreaker(
      opts.stormWindow ?? defaultStormWindow(),
      opts.stormThreshold ?? defaultStormThreshold(),
      opts.isMutating,
      opts.isStormExempt,
    );
  }

  /** Reset the storm window. Call at the start of every fresh user turn. */
  resetStorm(): void {
    this.storm.reset();
  }

  process(
    declaredCalls: RepairableToolCall[],
    reasoningContent: string | null,
    content: string | null = null,
  ): { calls: RepairableToolCall[]; report: RepairReport } {
    const report: RepairReport = {
      scavenged: 0,
      truncationsFixed: 0,
      truncationsUnrecoverable: 0,
      stormsBroken: 0,
      notes: [],
    };

    // 1. Scavenge — combine the two channels so we don't lose a call
    //    that landed in either reasoning_content or content. Existing
    //    declared signatures de-dup the scavenged ones.
    const combined = [reasoningContent ?? '', content ?? '']
      .filter((s) => typeof s === 'string' && s.length > 0)
      .join('\n');
    const scavenged = scavengeToolCalls(combined || null, {
      allowedNames: this.opts.allowedToolNames,
      maxCalls: this.opts.maxScavenge ?? 4,
    });
    const seenSignatures = new Set(declaredCalls.map(signatureOf));
    const merged: RepairableToolCall[] = [...declaredCalls];
    for (const sc of scavenged.calls) {
      const sig = signatureOf(sc);
      if (!seenSignatures.has(sig)) {
        merged.push(sc as unknown as RepairableToolCall);
        report.scavenged++;
        seenSignatures.add(sig);
      }
    }
    report.notes.push(...scavenged.notes);

    // 2. Truncation repair on each call's argument JSON.
    for (const call of merged) {
      const args = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
      if (!args || looksParseable(args)) continue;
      const r = repairTruncatedJson(args);
      if (r.fallback) {
        report.truncationsUnrecoverable++;
        report.notes.push(`[${call.function?.name}] ⚠️ TRUNCATION UNRECOVERABLE: ${r.notes[r.notes.length - 1] ?? 'unknown'}`);
        continue;
      }
      if (r.changed) {
        call.function.arguments = r.repaired;
        report.truncationsFixed++;
        report.notes.push(...r.notes.map((n) => `[${call.function?.name}] ${n}`));
      }
    }

    // 3. Storm breaker.
    const filtered: RepairableToolCall[] = [];
    for (const call of merged) {
      const verdict = this.storm.inspect(call as ToolCallLike);
      if (verdict.suppress) {
        report.stormsBroken++;
        if (verdict.reason) report.notes.push(verdict.reason);
        continue;
      }
      filtered.push(call);
    }

    return { calls: filtered, report };
  }
}

// ---- internals --------------------------------------------------------

function signatureOf(call: { function?: { name?: string; arguments?: string | object } }): string {
  const name = call.function?.name ?? '';
  const args = call.function?.arguments;
  const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  return `${name}::${argsStr}`;
}

function looksParseable(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function defaultStormWindow(): number {
  const raw = getCliKnobs().stormWindow;
  return Number.isFinite(raw) && raw >= 2 && raw <= 32 ? raw : 6;
}

function defaultStormThreshold(): number {
  // Default 4 — the existing per-turn legacy REPEAT_GUARD_LIMIT = 3
  // already suppresses the 4th identical call inside one runTurn. Our
  // pipeline-level guard adds scavenge / truncation / mutation-aware
  // clearing — keep its trigger one step LATER so it doesn't pre-empt
  // the legacy guard.
  const raw = getCliKnobs().stormThreshold;
  return Number.isFinite(raw) && raw >= 2 && raw <= 16 ? raw : 4;
}
