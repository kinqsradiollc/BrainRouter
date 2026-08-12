/**
 * ADR-028 G5 — the one Pull request panel, and the claim that it answers the
 * whole question it consolidated.
 *
 * §2.9 recorded G5 as Built with "checks and findings inline". Half of that was
 * true. `review` and `ci` were aliased onto `stack` at BOTH panel-open entry
 * points, so every caller asking for the review panel got the consolidated one
 * — which rendered Checks and nothing else. `ReviewPanel` stayed in the switch,
 * under a `case` no `PanelId` could select, while the chooser went on offering
 * a "Review" launcher badged with the finding count it was not going to show.
 *
 * That is this ADR's own defect, one level down from where the audit looked:
 * the module had importers, the case existed, the panel compiled. Nothing a
 * person could click reached it.
 *
 * So the tests here are about REACH, not rendering:
 *
 *   - a retired id is not a `PanelId`, so no new call site can ask for one,
 *   - the consolidated panel renders both halves,
 *   - opening it fetches the review data the second half needs,
 *   - and nothing offers a badge for something it will not display.
 *
 * They read source because the renderer is hook-heavy and cannot be mounted
 * outside React here, following `notes/notesMode.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PANEL_DEFS, MANUAL_PANEL_DEFS } from './panelCatalog.js';
import { migratePanelId, migratePanelIds } from '../lib/panels/lastSessionPanels.js';

const source = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

const renderPanelBody = source('../App/render/renderPanelBody.tsx');
const usePanels = source('../lib/panels/usePanels.ts');
const viewsRail = source('../components/layout/ViewsRail.tsx');

/** The body of `case '<id>': { … }` in the panel-body switch. */
function panelCase(id: string): string {
  const start = renderPanelBody.indexOf(`case '${id}': {`);
  assert.notEqual(start, -1, `renderPanelBody has no case for '${id}'`);
  const next = renderPanelBody.indexOf('\n      case ', start + 1);
  return renderPanelBody.slice(start, next === -1 ? undefined : next);
}

test('G5 — `review` and `ci` are not panels any more, anywhere', () => {
  const ids = new Set(PANEL_DEFS.map((d) => d.id));
  assert.equal(ids.has('stack' as never), true);
  assert.equal(ids.has('review' as never), false);
  assert.equal(ids.has('ci' as never), false);
  // The consolidated panel is the one that shows up in every "add a view" menu.
  assert.ok(MANUAL_PANEL_DEFS.some((d) => d.id === 'stack' && d.title === 'Pull request'));
});

test('G5 — the switch has no case a PanelId cannot select', () => {
  // A `case 'review'` here is dead the moment `review` leaves `PanelId`, and
  // dead is exactly how `ReviewPanel` spent a release.
  assert.doesNotMatch(renderPanelBody, /case 'review':/);
  assert.doesNotMatch(renderPanelBody, /case 'ci':/);
});

test('G5 — the Pull request panel renders BOTH checks and review findings', () => {
  const body = panelCase('stack');
  assert.match(body, /<CIPanel\b/, 'the Checks half is missing');
  assert.match(body, /<ReviewPanel\b/, 'the review findings half is missing — this is the state §2.9 described as built');
  assert.match(body, />Checks</);
  assert.match(body, />Review</);
});

test('G5 — ReviewPanel is reached ONLY from a panel a person can open', () => {
  // Guards the repair: if someone re-adds a `review` tab, the component ends up
  // in two places and one of them will be the unreachable one again.
  const uses = [...renderPanelBody.matchAll(/<ReviewPanel\b/g)];
  assert.equal(uses.length, 1, 'ReviewPanel should have exactly one render site');
  assert.ok(panelCase('stack').includes('<ReviewPanel'), 'its one render site must be the Pull request panel');
});

test('G5 — opening the Pull request panel fetches the findings it renders', () => {
  // A section wired to state nothing refreshes renders an empty list and reads
  // as "no findings", which is a worse lie than not showing the section.
  assert.match(
    usePanels,
    /if \(id === 'stack'\) q\('q-review-current', 'review-current'\)/,
    'refreshPanelData no longer loads the review on open',
  );
});

test('G5 — no panel-open entry point aliases a retired id', () => {
  // Aliasing here is what hid the retired ids from every caller: `review` kept
  // "working", so nothing ever pointed at the panel that renders.
  for (const fn of ['ensurePanel', 'offerPanel']) {
    const start = usePanels.indexOf(`function ${fn}(`);
    assert.notEqual(start, -1);
    const body = usePanels.slice(start, usePanels.indexOf('\n  }', start));
    assert.doesNotMatch(body, /migratePanelId/, `${fn} still aliases live callers`);
  }
});

test('G5 — a PERSISTED `review` or `ci` tab still migrates', () => {
  // The alias is right for stored layouts and wrong for call sites; removing it
  // from the entry points must not strand someone who quit with the old tab.
  assert.equal(migratePanelId('review'), 'stack');
  assert.equal(migratePanelId('ci'), 'stack');
  assert.deepEqual(migratePanelIds(['review', 'ci', 'files']), ['stack', 'files']);
});

test('G5 — the chooser offers ONE Pull request launcher, badged with what it shows', () => {
  const launchers = [...viewsRail.matchAll(/\{ id: '([a-z-]+)' as PanelId, title: '([^']+)'/g)]
    .map((m) => ({ id: m[1], title: m[2] }));
  assert.deepEqual(
    launchers.filter((l) => l.id === 'stack'),
    [{ id: 'stack', title: 'Pull request' }],
  );
  assert.deepEqual(launchers.filter((l) => l.id === 'review' || l.id === 'ci'), []);
  // The badge counts BOTH halves, because both are now on screen. It used to
  // count findings on a button that opened a panel showing only checks.
  assert.match(viewsRail, /const prFindings = review\?\.findings\.length \?\? 0;/);
  assert.match(viewsRail, /badge: prBadge/);
});
