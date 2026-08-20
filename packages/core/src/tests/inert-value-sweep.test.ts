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
 *  - **Modules are a pinned count.** Some exported modules are legitimately
 *    public SDK surface with no in-repo caller, so an automatic failure would
 *    be wrong. The count is asserted EXACTLY instead: a rise fails because a PR
 *    added something nothing calls, and a fall fails until the constant is
 *    lowered with it, so the slack from a wiring cannot be re-spent on the next
 *    orphan. The first version of this file allowed headroom, and fifteen of
 *    this ADR's own decisions sat inside it.
 *  - **Exports are a pinned count too, and that is the 2026-08-12 addition.**
 *    Everything above is MODULE-granular, and module granularity has an
 *    obvious hole: one live export makes a module look wired while its
 *    siblings are dead. Nine of this ADR's decisions were in exactly that
 *    state on the day the module sweep was declared fixed — `capabilityGap`
 *    and friends inside a module `runTurn` imports, three planner policy
 *    predicates inside a barrel the backend imports, `applyRemoteItem` beside
 *    a `syncOnce` the desktop calls every minute. The module check cannot see
 *    any of them, because it is not asking about them.
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
  // ADR-028 H3. Listed explicitly because the only mentions left inside core are
  // PROSE in `review/prRouter.ts` — a comment is not a consumer, and this sweep
  // cannot tell the difference. The reader is the desktop Track create-PR path.
  ['stackingMode', 'brainrouter-desktop/electron/host/github-track-services.ts:631 — Track create-PR'],
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
 * The ceiling. It only ever falls.
 *
 * Not zero, and not aiming to be: some of these are genuine public SDK surface
 * re-exported through package entry points, and failing on them would push
 * people to add fake callers.
 *
 * **It is asserted as an EQUALITY, not an upper bound, and that is the whole
 * point.** An upper bound is a budget, and a budget with room in it is where
 * orphans hide: this sweep shipped as `<= 32` against an actual 30, and four
 * modules from the very ADR that commissioned it — `task/messageReceipts.ts`,
 * `review/stackLifecycle.ts`, `graph/graphExecutor.ts`,
 * `workbench/workbenchActions.ts` — passed underneath it. A ratchet that only
 * catches a rise still lets the count sit wherever the last careless PR left it.
 *
 * 30 → 28 on 2026-08-12: C1's graph cluster went, and with it the last of the
 * four named above that was still a module rather than a decision.
 *
 * Equality fails in BOTH directions, which is what closes that:
 *
 *  - the count goes UP → a PR added a module nothing calls. Wire it or delete it.
 *  - the count goes DOWN → good, and the constant must be lowered in the same
 *    commit, so the slack cannot be silently re-spent on the next orphan.
 *
 * Counts UNDOCUMENTED orphans only — anything in `KNOWN_UNWIRED` is excluded.
 * Adding an entry there is therefore the one way to expand the budget, and it
 * costs a written, reviewable reason.
 */
// 28 → 27 with ADR-028's retirements, then → 26 when merging ADR-034 wired one
// up. The ratchet working in the direction it was built for.
const ORPHAN_MODULE_CEILING = 26;

/**
 * Modules that ARE orphans and are known to be, with the reason.
 *
 * The count alone was not enough, and the failure is instructive: it was
 * measured AFTER the planner modules landed, so the sweep built to catch
 * "declared but never wired" certified two instances of exactly that as the
 * floor. A number cannot tell you whether the tree it was measured against was
 * already wrong.
 *
 * So orphans that are known and intended get NAMED here. Anything orphaned and
 * not on this list is an accident; anything on this list is a debt someone
 * wrote down.
 *
 * **Empty, as of 2026-08-12**, and it should stay that way. The three planner
 * entries it held were stale in both directions: they described modules that had
 * since acquired importers, while the orphans that actually needed writing down
 * were absent. A stale exclusion is worse than no exclusion, because each one
 * silently widens the ceiling above by one — which is why the test below
 * requires every entry to still BE an orphan.
 */
const KNOWN_UNWIRED = new Map<string, string>([
  [
    'orchestration/execution/publicRuns.ts',
    'ADR-040 A40-9. The curated public surface for run views, and it IS reached: '
    + "brainrouter-cli/src/cli/commands/runs/index.ts imports it as "
    + "'@kinqs/brainrouter-core/orchestration/runs' through the package exports "
    + 'map. This sweep resolves relative imports inside core, so a cross-package '
    + 'subpath consumer is invisible to it — the module is wired, the scan just '
    + 'cannot see the wire. Verified by reading that file, not assumed.',
  ],
  [
    'exec/codeMode/runCodeChild.ts',
    'ADR-041 A41-15. The Code Mode child ENTRYPOINT: codeModeRunner.ts spawns it as '
    + "a subprocess via `node <new URL('./runCodeChild.js', import.meta.url)>`, so it "
    + 'is deliberately imported by nobody — it is executed, not linked. Reached at '
    + 'runtime, invisible to a static import scan by design (like any worker/child '
    + 'entry). Verified by reading codeModeRunner.ts.',
  ],
]);

test('E1 — the documented-orphan list is honest in both directions', () => {
  // The sweep must not launder its own author's orphans, and it must not carry
  // exclusions that have stopped being true — each of those is a free slot
  // under the ceiling that nobody chose to hand out.
  const orphans = new Set(modulesWithoutImporters());
  for (const [rel, reason] of KNOWN_UNWIRED) {
    assert.ok(reason.length > 10, `${rel} needs a real reason, not a placeholder`);
    assert.ok(
      SOURCE_TEXT.has(path.join(SRC, rel)),
      `KNOWN_UNWIRED names ${rel}, which no longer exists. Delete the entry.`,
    );
    assert.ok(
      orphans.has(rel),
      `KNOWN_UNWIRED still excuses ${rel}, but it has an importer now. Delete the ` +
        'entry — an exclusion that is no longer true quietly raises the orphan ceiling.',
    );
  }
});

test('E1 — the count of UNDOCUMENTED orphan modules is a ceiling that only falls', () => {
  const orphans = modulesWithoutImporters().filter((o) => !KNOWN_UNWIRED.has(o));
  assert.equal(
    orphans.length,
    ORPHAN_MODULE_CEILING,
    `Modules with no non-test importer: ${orphans.length}, ceiling ${ORPHAN_MODULE_CEILING}.\n` +
      (orphans.length > ORPHAN_MODULE_CEILING
        ? 'Something was added that nothing calls. Wire it up, or delete it. Raising ' +
          'the ceiling is a decision to argue for in review, not a way to land this.'
        : 'You wired one up — thank you. Lower ORPHAN_MODULE_CEILING to ' +
          `${orphans.length} in this same commit, so the slack cannot be quietly ` +
          'spent on the next orphan.') +
      '\n\nCurrent list:\n' +
      orphans.map((o) => `  - ${o}`).join('\n'),
  );
});

test('E1 — the modules this ADR wired are no longer orphans', () => {
  // The instances from §1.6 that were WIRED. The Part A stack cluster is not
  // here any more: it was retired rather than wired, so the honest check is
  // that its files are gone, below — an orphan assertion over a deleted file
  // passes for the wrong reason.
  const orphans = new Set(modulesWithoutImporters());
  for (const wired of [
    path.join('agent', 'runtime', 'engineSelection.ts'),
    path.join('review', 'stackCapability.ts'),
  ]) {
    assert.equal(orphans.has(wired), false, `${wired} lost its caller`);
  }
});

test('E1/B1 — the message-receipt lifecycle stays deleted', () => {
  // ADR-028 B1 wrote queued/delivered/acknowledged/dropped as a full lifecycle
  // whose only importer was its own test: no delivery path held receipt state
  // and no surface rendered one. ADR-034 D3 builds the same guarantee where the
  // messages actually are — `session_send` reporting "not delivered" and
  // "delivered, not yet seen" per recipient — and the acknowledged-on-evidence
  // half already ships as `task/steeringReceiptStore.ts` behind `reconcile_steer`.
  // A second receipt mechanism would be a second answer to one question.
  assert.equal(
    SOURCE_TEXT.has(path.join(SRC, 'task', 'messageReceipts.ts')),
    false,
    'task/messageReceipts.ts came back. Receipts belong to ADR-034 D3 on the real ' +
      'delivery path; a parallel lifecycle nothing calls is what B1 already was.',
  );
});

test('E1/D6 — the planner context reaches the model on the turn path', () => {
  // The regression test for D6. `buildPlannerContext` sat with no caller while
  // the planner TOOLS shipped, so the agent could operate a planner it could not
  // see. Deleting the call below — not merely the import — fails this.
  const phase = path.join('agent', 'runtime', 'contextPreparationPhase.ts');
  const text = SOURCE_TEXT.get(path.join(SRC, phase)) ?? '';
  assert.match(
    text,
    /applyPlannerContext\(agent\);/,
    'Nothing calls applyPlannerContext in the turn context phase — the planner is ' +
      'back to being a second place the user\'s intentions live.',
  );
  assert.match(text, /buildPlannerContext\(/, 'the phase no longer builds the planner block');
  assert.ok(
    reachableFromEntryPoints().has(phase),
    `${phase} is not reachable from any entry point, so its callers are inert`,
  );
});

test('E1 — the retired stack authoring and mutation modules stay deleted', () => {
  // ADR-028 A2/A3/A4/A5/A7: a create path, an exit-code contract, sync, merge
  // and a plan→stack mapping, none of which anything a user could do reached.
  // They were removed rather than left exported with a comment, because that
  // third option is what produced eleven decisions nobody could run.
  for (const retired of [
    'stackAuthoring.ts', 'stackLifecycle.ts', 'stackRunner.ts', 'stackExitCodes.ts', 'planToStack.ts',
  ]) {
    assert.equal(
      SOURCE_TEXT.has(path.join(SRC, 'review', retired)),
      false,
      `review/${retired} came back — wire it to something a user reaches, or leave it deleted`,
    );
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

/* ------------------------------------------------- E1 · export granularity */

/**
 * The repository, not just this package.
 *
 * Core is a LIBRARY: most of what it exports is consumed by the CLI, the
 * desktop, the dashboard or the brain, none of which this file could see. The
 * knob half of the sweep works around that with a hand-kept `CONSUMED_ELSEWHERE`
 * allowlist, which is affordable for thirty knobs and absurd for four thousand
 * exports. So the export half reads the sibling workspaces directly.
 *
 * Absent siblings are a FAILURE rather than a skip: run somewhere that cannot
 * see them and every export looks dead, which is a number that measures the
 * checkout instead of the code — the same class of mistake as the basename
 * collision that once made 74% of the package look unreachable.
 */
const REPO_ROOT = path.resolve(SRC, '..', '..', '..');
const CONSUMER_ROOTS = [
  'packages',
  'brainrouter/src',
  'brainrouter-cli/src',
  'brainrouter-desktop/src',
  'brainrouter-desktop/electron',
  'brainrouter-dashboard',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', '.next', 'build', 'coverage']);

function walkRepo(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) walkRepo(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(full)) out.push(full);
  }
  return out;
}

const isRepoTest = (f: string) =>
  f.includes(`${path.sep}tests${path.sep}`) || /\.test\.(ts|tsx)$/.test(f);

const CONSUMER_FILES = [
  ...new Set(CONSUMER_ROOTS.flatMap((rel) => walkRepo(path.join(REPO_ROOT, rel)))),
].filter((f) => !isRepoTest(f));

/**
 * Source with comments stripped.
 *
 * Prose is not a caller, and this sweep has already been fooled by that once:
 * `stackingMode` is on the knob allowlist precisely because the only mentions
 * left in core were in a comment. At export granularity the risk is worse,
 * because every retirement in this pass leaves a paragraph naming what it
 * removed — and a name in a paragraph explaining that nothing calls it would
 * otherwise register as something calling it.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CONSUMER_CODE = new Map(CONSUMER_FILES.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]));

/**
 * VALUE exports — functions, consts, classes, enums.
 *
 * Types are deliberately out of scope. An unused interface costs nothing at
 * runtime and disappears at compile time; an unused function is code that
 * looks like it runs. This sweep is about the second thing.
 */
function valueExports(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]!);
  for (const m of text.matchAll(/^export\s+(?:const|let|class|enum)\s+(\w+)/gm)) names.add(m[1]!);
  return [...names];
}

/**
 * Exports with no use in any non-test file, including their own module.
 *
 * The last clause is the whole reason this is tractable. `parseRobotsTxt` is
 * exported so its unit test can reach it and is called by `isAllowedByRobots`
 * three lines down — over-exported, not dead, and failing on it would push
 * people to un-export things for the checker rather than for the reader. What
 * is left after excluding those is code that genuinely never executes: 273
 * exports today, against roughly four thousand.
 *
 * Matching is textual, like the knob half, and for the same reason: a real
 * cross-package symbol resolution is a project of its own, and the shape that
 * actually ships is a NAME THAT APPEARS NOWHERE ELSE.
 */
function deadExports(): string[] {
  const dead: string[] = [];
  for (const file of NON_TEST) {
    const raw = SOURCE_TEXT.get(file) ?? '';
    const own = stripComments(raw);
    for (const name of valueExports(raw)) {
      const pattern = new RegExp(`\\b${name}\\b`);
      const elsewhere = CONSUMER_FILES.some(
        (other) => other !== file && pattern.test(CONSUMER_CODE.get(other) ?? ''),
      );
      if (elsewhere) continue;
      const usesHere = (own.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
      if (usesHere <= 1) dead.push(`${path.relative(SRC, file)} :: ${name}`);
    }
  }
  return dead.sort();
}

/**
 * The export ceiling. Like the module one, it only ever falls.
 *
 * Not zero, and unlike the module count it is a long way from zero — 273 is a
 * real number about a real backlog, and pretending otherwise by scoping the
 * check to a corner is precisely the mistake the `planner/` filter was. What
 * makes an equality useful at this size is that it fails on the DELTA: a PR
 * that adds an export nothing calls raises it, and no amount of pre-existing
 * debt hides that.
 *
 * It caught nine of this ADR's own decisions the first time it ran.
 *
 * **It rose once, on purpose, and this is the record of it.** ADR-028's
 * retirements took it 273 → 270. Merging ADR-034 (messages that arrive) put it
 * back to 273 with three exports that compile, typecheck, are covered by tests,
 * and are called by nothing on a user path:
 *
 * - `session/input/heldSessionMessages.ts :: rejectHeldSessionMessage` (3 test refs)
 * - `session/messaging/routes.ts :: findSessionRouteByKey` (5 test refs)
 * - `session/sessionTitle.ts :: resolveSessionTitle` (5 test refs) — a second
 *   variant of `resolveSessionTitleDecision`, which IS the one `agent.ts` calls
 *
 * They are named rather than absorbed because an unexplained ceiling rise is
 * how a ratchet stops meaning anything, and because deleting another decision's
 * tested behaviour inside a merge commit is not the merge's call to make. Each
 * must be wired or deleted; when that happens this comment goes and the number
 * falls with it.
 *
 * **The A40-5 and A40-6 rises are REPAID.** Those two slices took it 273 → 279
 * while their reducer and durable store had no caller. A40-7's adapter wired
 * both, and the sweep immediately flagged their exclusions as stale — a ratchet
 * that only catches new debt and never notices repayment is just a bigger
 * number. What remains is A40-7's own frontier: the adapter's exports are dead
 * until A40-9 and A40-10 render the map. Named, attributed, and it falls when
 * they land. A40-9 then took it 280 → 279 by giving the run views a real
 * consumer: the ratchet falling, which is the direction it is for. A40-8 raised
 * it 279 → 281 for `adaptiveActivation.ts`, then GATE-WIRED by A40-8's completion, taking it
 * 282 → 280: the module is now imported at the live root-turn seam
 * (`activeTurnOrchestration.ts`), so its eligibility, diagnostics and the
 * `DEFAULTS_ARE_CORPUS_GATED` gate run per turn as a real INVARIANT — inertly,
 * because the resolver only honors workspace config, so no default moves.
 * Wiring the gate is not opening it: the corpus gate stays SHUT and the suite
 * still pins it there. A40-11 raised it 281 → 285 for
 * `optimizationSubgraph.ts`, then its MIGRATION took it 280 → 278: the build loop's
 * critic gate and merge/rollback now emit `judgeOptimizationRound` /
 * `engineeringBuildLoopRound` verdicts into the map (workflowTool.ts), so three of
 * those exports gained a production caller. The loop's existing gates still decide;
 * the vocabulary only records what they decided. Generalise first, migrate second,
 * old path retained — done.

 * **It rose to 286 then fell back: 286 → 285, ADR-040 A40-7 wiring.**
 * `orchestration/execution/phasePlanAdapter.ts` is now composed into the live
 * executePhasePlan hooks (workflowTool.ts; execution-phase-plan-wiring.test.ts,
 * lastSequence + best-effort-guard mutation-proved), so its emitter export has a
 * non-test caller and left the dead set. The module also left KNOWN_UNWIRED above.
 *
 * **Fell again 284 → 283, ADR-040 A40-7 resume emission.** `readDurableRunResumeState`
 * gained a production caller: the phase-plan emitter reads it to continue a resumed
 * run's event sequence from where the interrupted run left off.
 *
 * **Fell again 283 → 282, ADR-040 A40-9 retained journal.** `reduceExecutionEvents`
 * gained a production caller: `readRunDetail` reduces a run's retained event journal
 * so `/runs <id>` rebuilds the map from disk instead of reporting `unavailable`.
 */
const DEAD_EXPORT_CEILING = 278;

test('E1 — the repository is visible, or this sweep measures nothing', () => {
  // A guard, not a formality: with the siblings missing, every export below
  // reads as dead and the ceiling assertion fails with a number that says
  // nothing about the code. Better to fail here, where the message is true.
  assert.ok(
    CONSUMER_FILES.length > 2000,
    `Only ${CONSUMER_FILES.length} consumer files found under ${REPO_ROOT}. The export ` +
      'sweep needs the sibling workspaces (CLI, desktop, dashboard, brain) to know what ' +
      'calls core. Run it from a full checkout.',
  );
});

test('E1 — the count of DEAD exports is a ceiling that only falls', () => {
  const dead = deadExports();
  assert.equal(
    dead.length,
    DEAD_EXPORT_CEILING,
    `Exports with no non-test caller anywhere — not in another package, not even in ` +
      `their own module: ${dead.length}, ceiling ${DEAD_EXPORT_CEILING}.\n` +
      (dead.length > DEAD_EXPORT_CEILING
        ? 'A PR added an export nothing calls. This is the MODULE check one level down: ' +
          'the module has other exports that are wired, so nothing else here notices.\n' +
          'Wire it, un-export it, or delete it.'
        : 'You removed one — thank you. Lower DEAD_EXPORT_CEILING to ' +
          `${dead.length} in this same commit, so the slack cannot be quietly spent on ` +
          'the next one.') +
      '\n\nFirst twelve:\n' +
      dead.slice(0, 12).map((d) => `  - ${d}`).join('\n'),
  );
});

/**
 * Exports ADR-028 retired, and the reason each was not wired instead.
 *
 * The ceiling above catches a RISE. It cannot notice a specific export coming
 * back if something else was deleted in the same commit, and these are the ones
 * where that matters: each was reached only by its own unit test, inside a
 * module the module-granular sweep had already certified as wired, and each was
 * therefore invisible to every check this file had before today.
 */
const RETIRED_EXPORTS = new Map<string, string>([
  ['agent/runtime/engineSelection.ts :: selectEngine', 'C1 — one engine; the whole module is gone'],
  ['planner/agentContext.ts :: classifyPlannerAction', 'D6 — toolCatalog.ts classifies the verbs that exist'],
  ['planner/agentContext.ts :: mayCompleteFromInference', 'D6 — enforced by there being no inferring caller'],
  ['planner/agentContext.ts :: mayRaiseBacklog', 'D6 — gates a proposer §6 has not decided to build'],
  ['planner/plannerService.ts :: timetableView', 'D5 — todayView answers it from the same dayView'],
  ['planner/plannerSync.ts :: applyRemoteItem', 'D11 — its cascade is a SyncRecords.afterApply hook now'],
  ['planner/plannerSync.ts :: describeSync', 'D11 — describeRecordSync already defaults to "item"'],
  ['planner/sourceAdapter.ts :: collectFromSources', 'D7 — one source, and freshness comes from the items'],
  ['planner/sourceAdapter.ts :: partitionForRetention', 'D8 — retention runs server-side, where the rows are'],
  ['planner/connectorIssueAdapter.ts :: refreshLocalPlannerFromConnectorIssues', 'D7 — the server owns the projection'],
  ['planner/wireContract.ts :: isPlannerPushOperation', 'D11 — callers need the normalized operation, not a boolean'],
  ['sync/outbox.ts :: replayOrder', 'D2 — nextBatch is where per-item order is actually kept'],
  ['sync/hybridClock.ts :: formatHlc', 'D3 — stamps cross the wire as objects'],
  ['sync/hybridClock.ts :: parseHlc', 'D3 — same'],
  ['tooling/gitIdentity.ts :: describeAccounts', 'I4 — there is no account picker, and none proposed'],
]);

test('E1 — the exports ADR-028 retired have not come back', () => {
  const back: string[] = [];
  for (const entry of RETIRED_EXPORTS.keys()) {
    const [rel, name] = entry.split(' :: ');
    const raw = SOURCE_TEXT.get(path.join(SRC, rel!));
    if (!raw) continue; // module deleted outright — retired harder
    if (valueExports(raw).includes(name!)) back.push(entry);
  }
  assert.deepEqual(
    back,
    [],
    'These were retired because nothing outside their own test reached them:\n' +
      back.map((b) => `  - ${b} (${RETIRED_EXPORTS.get(b)})`).join('\n') +
      '\n\nIf one is needed again, it needs a caller in the same commit — and then ' +
      'this entry comes out with a note saying who calls it.',
  );
});

test('E1/H4 — what survives of the stack support IS reachable', () => {
  // The regression test for the thing H1 fixed. `prRouter` builds every PR
  // argv and `stackedPr` is the read model the PR review renders; if either
  // stops being reached from an entry point, what is left of stacks is
  // unreachable from the product again and this fails.
  const reachable = reachableFromEntryPoints();
  for (const wired of [
    path.join('review', 'prRouter.ts'),
    path.join('review', 'stackProbe.ts'),
    path.join('review', 'stackedPr.ts'),
  ]) {
    assert.ok(reachable.has(wired), `${wired} is not reachable from any entry point`);
  }
});
