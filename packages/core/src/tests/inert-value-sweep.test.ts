/**
 * ADR-028 E1 — the sweep for values nobody reads.
 *
 * Five instances of one shape shipped in a single release: a knob resolved,
 * validated and unit-tested with nothing consuming it, or a module written and
 * unit-tested with no non-test importer. Each was fixed as it surfaced, which
 * is precisely how the sixth ships.
 *
 *   A module or setting is not done until something calls it, and the test
 *   proving the caller exists is a DIFFERENT test from the one proving the
 *   unit works.
 *
 * That second test is this file. It is mechanical on purpose — a review habit
 * is exactly what failed five times.
 *
 * Two policies, deliberately different:
 *
 *  - **Knobs fail the build.** A `cli.*` setting with no reader is always a
 *    defect: a person can set it and watch nothing happen.
 *  - **Modules are a reviewed baseline.** Some exported modules are legitimately
 *    public SDK surface with no in-repo caller, so an automatic failure would
 *    be wrong. The count is pinned instead; a RISE fails, which turns "nobody
 *    noticed" into "this PR added one".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const ALL_FILES = walk(SRC);
const isTest = (f: string) => f.includes(`${path.sep}tests${path.sep}`) || f.endsWith('.test.ts');
const NON_TEST = ALL_FILES.filter((f) => !isTest(f));
const SOURCE_TEXT = new Map(NON_TEST.map((f) => [f, readFileSync(f, 'utf8')]));

/* --------------------------------------------------------------- knobs */

/**
 * The resolved-knob surface: every key on the object `resolveCliKnobs` returns.
 *
 * Read from the resolver rather than from a hand-kept list, because a
 * hand-kept list is the thing that goes stale and lets the next one through.
 */
function resolvedKnobNames(): string[] {
  const text = SOURCE_TEXT.get(path.join(SRC, 'config', 'config.ts')) ?? '';
  const start = text.indexOf('export function resolveCliKnobs');
  assert.ok(start > 0, 'resolveCliKnobs must exist for this sweep to mean anything');
  const body = text.slice(start, start + 20_000);
  const names = new Set<string>();
  for (const m of body.matchAll(/^\s{4}(\w+):/gm)) names.add(m[1]!);
  return [...names];
}

/**
 * Knobs whose only reader is the resolver itself are, by definition, inert.
 *
 * A knob "has a consumer" when some non-config, non-test file mentions it.
 * Crude, and deliberately so: a precise reachability analysis would be a
 * project of its own, and this catches the shape that actually shipped five
 * times — a name that appears nowhere but where it is defined.
 */
function knobConsumers(knob: string): string[] {
  const pattern = new RegExp(`\\b${knob}\\b`);
  return NON_TEST.filter((f) => {
    if (f.includes(`${path.sep}config${path.sep}`)) return false;
    return pattern.test(SOURCE_TEXT.get(f) ?? '');
  });
}

/**
 * Knobs whose consumer lives outside this package.
 *
 * This sweep only sees `packages/core`, and the CLI reads many knobs directly,
 * so an allowlist is unavoidable. Every entry names the FILE that reads it —
 * verified, not assumed. That is the difference between an allowlist and a
 * place to hide things: adding a line here means going and finding the caller,
 * and if you cannot find one, the knob is inert and belongs in the failure.
 */
const CONSUMED_ELSEWHERE = new Map<string, string>([
  ['skillsStackMax', 'brainrouter-cli/src/prompt/skillRunner.ts — stack cap'],
  ['skillsKeywordTriggers', 'brainrouter-cli/src/cli/ink/runChat/dispatch.ts — kill-switch'],
  ['markdownCheckboxes', 'brainrouter-cli/src/cli/ink/text/markdownRender.ts'],
  ['notifyBell', 'brainrouter-cli/src/cli/ink/runChat/completions.ts'],
  ['fleetMaxConcurrentJobs', 'brainrouter-cli/src/entry/fleetCommand.ts'],
  ['scheduleTickMs', 'brainrouter-cli/src/runtime/background/scheduleTicker.ts'],
  ['updateCheck', 'brainrouter-cli/src/runtime/update/updateApply.ts'],
  ['autoExtractSkills', 'brainrouter-cli/src/cli/ink/runChat/turnRunner.ts'],
  ['autoReplayOffline', 'brainrouter-cli/src/cli/ink/runChat.tsx'],
  ['browserSmoke', 'brainrouter-cli/src/runtime/verify/browserVerify.ts'],
  ['debugExit', 'brainrouter-cli/src/index.ts'],
  ['altScreen', 'brainrouter-cli/src/cli/ink/terminal/renderWithResizeClear.ts'],
  ['hideCursor', 'brainrouter-cli/src/cli/ink/terminal/renderWithResizeClear.ts'],
  ['skillsHideBundled', 'brainrouter-cli/src/prompt/skillCatalog.ts + desktop settings'],
]);

test('E1 — every resolved cli.* knob has a consumer', () => {
  const knobs = resolvedKnobNames();
  assert.ok(knobs.length > 20, `expected a substantial knob surface, found ${knobs.length}`);

  const inert = knobs.filter(
    (k) => !CONSUMED_ELSEWHERE.has(k) && knobConsumers(k).length === 0,
  );

  assert.deepEqual(
    inert,
    [],
    `These cli.* knobs are resolved and validated but nothing reads them:\n` +
      inert.map((k) => `  - ${k}`).join('\n') +
      '\n\nWire it, delete it, or — if the consumer lives in the CLI or desktop — ' +
      'add it to CONSUMED_ELSEWHERE with the reason. A setting a person can change ' +
      'and watch do nothing is the defect this sweep exists to catch.',
  );
});

/* -------------------------------------------------------------- modules */

/** Modules with no importer outside their own tests. */
function modulesWithoutImporters(): string[] {
  const orphans: string[] = [];
  for (const file of NON_TEST) {
    const rel = path.relative(SRC, file);
    if (rel === 'index.ts' || rel.endsWith(`${path.sep}index.ts`)) continue;
    const base = path.basename(file, '.ts');
    // Match `from '.../<base>.js'` in any other non-test source file.
    const pattern = new RegExp(`from\\s+['"][^'"]*\\b${base}\\.js['"]`);
    const imported = NON_TEST.some((other) => other !== file && pattern.test(SOURCE_TEXT.get(other) ?? ''));
    if (!imported) orphans.push(rel);
  }
  return orphans.sort();
}

/**
 * The baseline.
 *
 * Not zero, and not aiming to be: some of these are genuine public SDK surface
 * re-exported through package entry points, and failing on them would push
 * people to add fake callers. What matters is the direction — a rise means a
 * PR added a module nothing calls, which is the moment to ask whether it is
 * finished.
 *
 * Counts UNDOCUMENTED orphans only — anything in `KNOWN_UNWIRED` is excluded.
 * That makes writing a module down the thing that lowers the number, rather
 * than a separate bookkeeping step somebody forgets, and it means the baseline
 * cannot quietly absorb new orphans by being bumped alongside them.
 *
 * Set to the exact count, not a round number with headroom. Headroom is how a
 * sweep passes while the thing it watches for keeps happening — the first
 * version of this test used 400 against an actual 34, and would have absorbed a
 * decade of orphans without ever failing.
 *
 * Lower this when you wire one up. Raising it should feel like a decision.
 */
const ORPHAN_MODULE_BASELINE = 32;

/**
 * Modules that ARE orphans and are known to be, with the reason.
 *
 * The baseline alone was not enough, and the failure is instructive: it was
 * measured AFTER the planner modules landed, so the sweep built to catch
 * "declared but never wired" certified two instances of exactly that as the
 * floor. A number cannot tell you whether the tree it was measured against was
 * already wrong.
 *
 * So orphans that are known and intended get NAMED here. Anything orphaned and
 * not on this list is an accident; anything on this list is a debt someone
 * wrote down.
 */
const KNOWN_UNWIRED = new Map<string, string>([
  ['planner/agentContext.ts', 'ADR-028 D6 — awaits the planner tool registration'],
  ['planner/outbox.ts', 'ADR-028 D2 — awaits the sync client (D11)'],
  ['planner/plannerService.ts', 'ADR-028 D9 — awaits the desktop/dashboard/CLI surfaces'],
  ['planner/plannerSync.ts', 'ADR-028 D11 — awaits the backend transport (G6 planner mode)'],
]);

test('E1 — known-unwired modules are NAMED, not absorbed by the baseline', () => {
  // The sweep must not launder its own author's orphans.
  const orphans = new Set(modulesWithoutImporters());
  for (const [rel, reason] of KNOWN_UNWIRED) {
    assert.ok(reason.length > 10, `${rel} needs a real reason, not a placeholder`);
  }
  const undocumented = [...orphans].filter(
    (o) => o.startsWith('planner/') && !KNOWN_UNWIRED.has(o),
  );
  assert.deepEqual(
    undocumented,
    [],
    'A planner module became an orphan without being written down:\n' +
      undocumented.map((o) => `  - ${o}`).join('\n'),
  );
});

test('E1 — the count of UNDOCUMENTED orphan modules does not RISE', () => {
  const orphans = modulesWithoutImporters().filter((o) => !KNOWN_UNWIRED.has(o));
  assert.ok(
    orphans.length <= ORPHAN_MODULE_BASELINE,
    `Modules with no non-test importer rose to ${orphans.length} ` +
      `(baseline ${ORPHAN_MODULE_BASELINE}).\n` +
      'Something was added that nothing calls. Either wire it up, or — if it is ' +
      'genuinely public SDK surface — raise the baseline deliberately and say why ' +
      'in the commit.\n\nCurrent list starts:\n' +
      orphans.slice(0, 15).map((o) => `  - ${o}`).join('\n'),
  );
});

test('E1 — the modules this ADR wired are no longer orphans', () => {
  // The five instances from §1.6, plus what Part A/C added. If any of these
  // reappears here, a wiring was reverted.
  const orphans = new Set(modulesWithoutImporters());
  for (const wired of [
    path.join('agent', 'runtime', 'engineSelection.ts'),
    path.join('review', 'stackExitCodes.ts'),
    path.join('review', 'stackCapability.ts'),
    path.join('review', 'stackRunner.ts'),
  ]) {
    assert.equal(orphans.has(wired), false, `${wired} lost its caller`);
  }
});


/* ------------------------------------------------- H4 · reachability */

/**
 * Entry points — the places a USER can reach code from.
 *
 * The importer check is too weak, and Part A proved it: `stackAuthoring`
 * imports `stackRunner`, which imports `stackCapability`. A cluster that only
 * calls itself passes an importer-existence check while being exactly as inert
 * as a lone orphan. Five modules and eleven decisions sat unreachable for weeks
 * because each had an importer.
 *
 *   A module is not done until something a USER can reach calls it.
 */
const ENTRY_POINTS = [
  'extension/builtin/runtime.ts',   // agent tools
  'extension/builtin/toolCatalog.ts',
  'agent/runtime/runTurn.impl.ts',  // the turn loop
  'config/config.ts',               // knob resolution
];

/**
 * The package's own `exports` map, which is the honest definition of what an
 * external consumer can reach. Read from package.json rather than hand-listed,
 * because a hand-listed set goes stale exactly like the knob list would have.
 */
function exportedEntryPoints(): string[] {
  const pkgPath = path.resolve(SRC, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    exports?: Record<string, { default?: string } | string>;
  };
  const targets: string[] = [];
  for (const value of Object.values(pkg.exports ?? {})) {
    const dist = typeof value === 'string' ? value : value?.default;
    if (!dist) continue;
    // ./dist/agent/index.js → agent/index.ts
    const rel = dist.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts');
    if (SOURCE_TEXT.has(path.join(SRC, rel))) targets.push(rel);
  }
  return targets;
}

/**
 * Every module reachable by following imports from the entry points.
 *
 * Imports are resolved RELATIVE TO THE IMPORTING FILE, not by basename. The
 * first version of this keyed a basename→path map, so every `index.ts` in the
 * tree collided into one entry and 74% of the package looked unreachable —
 * a number that measured the bug, not the codebase. A check whose failure mode
 * is a wrong number nobody can act on is worse than no check.
 */
function reachableFromEntryPoints(): Set<string> {
  const exists = (rel: string): boolean => SOURCE_TEXT.has(path.join(SRC, rel));

  /** `./foo.js` from `a/b.ts` → `a/foo.ts`; also tries `<spec>/index.ts`. */
  function resolveSpec(fromRel: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null;
    const base = path.posix.join(path.posix.dirname(fromRel.split(path.sep).join('/')), spec);
    const asFile = `${base.replace(/\.js$/, '')}.ts`.split('/').join(path.sep);
    if (exists(asFile)) return asFile;
    const asIndex = path.join(base.replace(/\.js$/, ''), 'index.ts');
    return exists(asIndex) ? asIndex : null;
  }

  const seen = new Set<string>();
  const queue: string[] = [];
  for (const entry of [...ENTRY_POINTS, ...exportedEntryPoints()]) {
    if (exists(entry)) queue.push(entry);
  }

  while (queue.length > 0) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = SOURCE_TEXT.get(path.join(SRC, rel));
    if (!text) continue;
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const target = resolveSpec(rel, m[1]!);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

/**
 * Modules that are imported by something, yet reachable by nobody.
 *
 * This is the shape the importer check misses and Part A shipped.
 */
function unreachableButImported(): string[] {
  const reachable = reachableFromEntryPoints();
  const orphans = new Set(modulesWithoutImporters());
  return NON_TEST
    .map((f) => path.relative(SRC, f))
    .filter((rel) => !reachable.has(rel) && !orphans.has(rel))
    .sort();
}

/**
 * The baseline for unreachable-but-imported clusters.
 *
 * Pinned to today's exact count: 86 of 782 modules. A RISE means a PR added
 * code that other code calls while nothing a user can do reaches any of it —
 * the Part A shape, caught the day it lands instead of weeks later in the
 * product.
 *
 * Most of the 86 are sub-barrels (`agent/fs/index.ts` and friends) re-exported
 * by a parent, which the walk does not credit. That is a known imprecision, and
 * it is fine for a rise-detector: the number only has to be STABLE to be
 * useful, not minimal.
 */
const UNREACHABLE_CLUSTER_BASELINE = 86;

test('E1/H4 — the count of imported-but-UNREACHABLE modules does not rise', () => {
  const unreachable = unreachableButImported();
  assert.ok(
    unreachable.length <= UNREACHABLE_CLUSTER_BASELINE,
    `Imported-but-unreachable modules rose to ${unreachable.length} ` +
      `(baseline ${UNREACHABLE_CLUSTER_BASELINE}).\n` +
      'Something was added that other code calls, but that nothing a USER can reach ' +
      'calls. That is how Part A shipped five modules nobody could get to.\n\n' +
      unreachable.slice(0, 12).map((o) => `  - ${o}`).join('\n'),
  );
});

test('E1/H4 — the stack modules ARE reachable now that the PR router wires them', () => {
  // The regression test for the thing H1 fixed. If `prRouter` stops being
  // reached from an entry point, stacked PRs are unreachable from the product
  // again and this fails.
  const reachable = reachableFromEntryPoints();
  for (const wired of [
    path.join('review', 'prRouter.ts'),
    path.join('review', 'planToStack.ts'),
    path.join('review', 'stackedPr.ts'),
  ]) {
    assert.ok(reachable.has(wired), `${wired} is not reachable from any entry point`);
  }
});
