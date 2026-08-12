/**
 * ADR-028 C1 — the graph engine and its knob are RETIRED, and stay retired.
 *
 * What this replaces is instructive. There were two passing test files here:
 * `engine-selection.test.ts` proved the selector fell back correctly, and
 * `execution-engine-knob.test.ts` proved `cli.executionEngine` resolved and
 * validated. Both passed for two releases while the thing they were about —
 * running a turn on the graph — could not happen at all:
 *
 *  - `ENGINE_CAPABILITIES` gave graph no interrupts, no tool authorization, no
 *    receipts and no delegation, so `selectEngine` always returned the loop;
 *  - the `allowIncomplete` escape that would have honoured the request anyway
 *    was passed by nothing but a test;
 *  - `graph/graphExecutor.ts` had exactly one importer in the repository — its
 *    own test — so even had the selector returned `graph`, there was no code
 *    path from `runTurn` to the executor.
 *
 * C1's rejected alternative was "delete the knob and ship only the loop",
 * rejected because the graph's value for interrupted, resumable work is real.
 * It was also zero, and §5 reserved this decision explicitly: if parity is more
 * than a week away, say so and reconsider whether the option should exist.
 * Taken 2026-08-12.
 *
 * This file asserts the ABSENCE, because absence is the thing that regresses
 * quietly. A future PR re-adding an engine selector has to delete these
 * assertions, and deleting them is a decision someone makes in review rather
 * than a file that silently reappears.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliKnobs } from '../config/config.js';

// `../../src` rather than `..`: these tests run from `dist/tests/` after a
// build, so a relative walk from the module's own directory lands in `dist`,
// where there is no TypeScript to read.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FILES = walk(SRC);
const exists = (rel: string): boolean => FILES.includes(path.join(SRC, rel));

test('the graph executor cluster stays deleted', () => {
  // Wire it to a turn or leave it deleted. Bringing the modules back "for
  // later" is what produced eleven decisions nobody could run.
  for (const rel of [
    path.join('graph', 'graphExecutor.ts'),
    path.join('graph', 'graphState.ts'),
    path.join('graph', 'compensation.ts'),
    path.join('agent', 'runtime', 'engineSelection.ts'),
  ]) {
    assert.equal(exists(rel), false, `${rel} came back without a turn that reaches it`);
  }
});

/** Source with comments removed, so prose about a retirement is not a use. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('runTurn dispatches on nothing — there is one engine', () => {
  const turn = code(readFileSync(path.join(SRC, 'agent', 'runtime', 'runTurn.impl.ts'), 'utf8'));
  assert.doesNotMatch(turn, /selectEngine|describeRunningEngine|executionEngine/);
});

test('cli.executionEngine is no longer resolved, so nothing can read it', () => {
  // The knob sweep (E1) fails on a resolved knob with no consumer. The honest
  // end state is not a consumer, it is no knob: with one engine there is
  // nothing to select, and a single-valued setting is the same defect wearing
  // a smaller hat.
  const knobs = resolveCliKnobs({ cli: { executionEngine: 'graph' } } as never) as unknown as Record<string, unknown>;
  assert.equal('executionEngine' in knobs, false, 'the resolver grew the knob back');
});

test('a stale cli.executionEngine in a config file is inert, not an error', () => {
  // Config files in the wild carry it. Rejecting the key would turn a
  // no-longer-meaningful setting into a broken install.
  assert.doesNotThrow(() => resolveCliKnobs({ cli: { executionEngine: 'nonsense' } } as never));
  const withKnob = resolveCliKnobs({ cli: { executionEngine: 'graph' } } as never);
  const without = resolveCliKnobs({ cli: {} } as never);
  assert.deepEqual(withKnob, without);
});

test('no module claims a second execution engine', () => {
  // The words, not just the files: a `EngineKind`/`ENGINE_CAPABILITIES` pair
  // reappearing anywhere in core is the same decision being re-made without
  // the parity that makes it honest.
  // Production modules only. Tests NAME the retired symbols on purpose — the
  // sweep's `RETIRED_EXPORTS` list is what fails when one comes back — and a
  // check that cannot tell a guard from a regression is a check people delete.
  const offenders = FILES
    .filter((f) => !f.includes(`${path.sep}tests${path.sep}`) && !f.endsWith('.test.ts'))
    .filter((f) => /\bENGINE_CAPABILITIES\b|\bEngineKind\b|\bselectEngine\b/.test(code(readFileSync(f, 'utf8'))))
    .map((f) => path.relative(SRC, f));
  assert.deepEqual(offenders, []);
});
