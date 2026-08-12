/**
 * ADR-028 G3 — panel grouping.
 *
 * The grouping only earns its click if every panel lands somewhere sensible and
 * empty groups never appear.
 *
 * The tests below split into two claims, deliberately, because for one release
 * only the first was true: the grouping WORKED and nothing CALLED it. §2.9
 * recorded G3 as Built on the strength of `panelCatalog.ts:66-103` existing,
 * while the only importer of `PANEL_GROUPS` / `groupOf` / `panelsInGroup` /
 * `activeGroups` was this file, and the views chooser — the one list a person
 * scans — grouped by five names it kept to itself. A unit that works and a unit
 * that is called are two different claims, so they are two different tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PANEL_DEFS, groupOf, panelsInGroup, activeGroups, PANEL_GROUPS, type PanelId } from './panelCatalog.js';

const source = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

test('every registered panel has a group', () => {
  // An unmapped panel falls to Environment, which is a silent wrong answer
  // rather than a visible one — so assert the mapping is deliberate.
  const ungrouped = PANEL_DEFS
    .map((d) => d.id)
    .filter((id) => groupOf(id) === 'environment')
    .filter((id) => !['tools', 'servers', 'peers', 'browser', 'context', 'atlas', 'prototype'].includes(id));
  assert.deepEqual(ungrouped, [], `these panels fell to Environment by default: ${ungrouped.join(', ')}`);
});

test('the consolidated Pull request panel is Work, not Code', () => {
  // Deciding whether to land a change is work; reading the change is code.
  assert.equal(groupOf('stack'), 'work');
  assert.equal(groupOf('diff'), 'code');
});

test('comprehension is its own group — that is what makes room for it', () => {
  assert.equal(groupOf('comprehension'), 'understand');
});

test('an EMPTY group is never offered', () => {
  // A click that leads to a blank panel is worse than one fewer group.
  assert.deepEqual(activeGroups(['files', 'diff'] as PanelId[]), ['code']);
  assert.deepEqual(activeGroups([] as PanelId[]), []);
});

test('groups list the panels actually open, in catalog order', () => {
  const open = ['stack', 'files', 'plan'] as PanelId[];
  assert.deepEqual(panelsInGroup('work', open), ['stack', 'plan']);
  assert.deepEqual(panelsInGroup('code', open), ['files']);
  assert.deepEqual(panelsInGroup('knowledge', open), []);
});

test('every group has a label', () => {
  for (const [, label] of PANEL_GROUPS) assert.ok(label.length > 2);
});

// ---------------------------------------------------------------------------
// Reachability. Asserted at the source because ViewsRail is hook-heavy and
// cannot be rendered outside React here — the same reason ADR-029's mode tests
// read source.
// ---------------------------------------------------------------------------

const viewsRail = source('../components/layout/ViewsRail.tsx');
/**
 * The chooser's source with its `import` statements stripped.
 *
 * Importing a symbol is not using one — that distinction is the whole of H4,
 * and a check that reads the import line is the check H4 was written to
 * replace. It would pass on a file that imports `activeGroups` and then maps
 * over every group regardless.
 */
const viewsRailBody = viewsRail.replace(/^import [\s\S]*?from '[^']+';$/gm, '');

test('G3 — the views chooser groups by the CATALOG, not a taxonomy of its own', () => {
  // This is the assertion §2.9's G3 row needed and did not have. The chooser is
  // the list G3 exists for; if it stops CALLING these, the grouping is back to
  // being read by nothing but the tests above.
  for (const fn of ['activeGroups', 'groupOf', 'panelsInGroup']) {
    assert.match(
      viewsRailBody,
      new RegExp(`\\b${fn}\\(`),
      `ViewsRail no longer calls ${fn} — the panel grouping is an orphan again`,
    );
  }
  assert.match(viewsRailBody, /\bPANEL_GROUPS\b/, 'the group labels no longer come from the catalog');
  assert.match(viewsRail, /from '\.\.\/\.\.\/panels\/panelCatalog\.js'/);
});

test('G3 — the chooser carries no second set of group names', () => {
  // The defect was not a missing grouping, it was TWO. A local group table here
  // is what let the catalog's five names go unread for a release.
  assert.doesNotMatch(viewsRail, /LAUNCHER_GROUPS/);
  assert.doesNotMatch(viewsRail, /\bgroup:\s*'/);
});

test('G3 — every group the chooser can show has a launcher that opens it', () => {
  // An id in the launcher list that is not a registered panel opens nothing;
  // `viewRecommendations` carried two of those for a release. Read the ids the
  // chooser offers straight out of its source and check them against the
  // catalog, so a typo or a retired id fails here rather than on click.
  const ids = [...viewsRail.matchAll(/\{ id: '([a-z-]+)' as PanelId,/g)].map((m) => m[1]);
  assert.ok(ids.length >= 15, `only found ${ids.length} launchers — the scrape is wrong, not the code`);
  const registered = new Set<string>([...PANEL_DEFS.map((d) => d.id), 'terminal']);
  const unopenable = ids.filter((id) => !registered.has(id));
  assert.deepEqual(unopenable, [], `these launchers name no registered panel: ${unopenable.join(', ')}`);

  // And the reverse of `activeGroups`: every group the chooser could render a
  // heading for is one a launcher can actually populate.
  const offered = activeGroups(ids.filter((id) => id !== 'terminal') as PanelId[]);
  for (const group of offered) {
    assert.ok(panelsInGroup(group, ids as PanelId[]).length > 0, `group ${group} would render an empty heading`);
  }
});
