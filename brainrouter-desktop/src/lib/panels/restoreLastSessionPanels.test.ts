/**
 * ADR-028 G2 — the clean start removes an assumption, not a capability.
 *
 * That claim rested on a "reopen last session's panels" action which existed,
 * was returned from the hook, was destructured in App.tsx — and was called by
 * nothing. It could not have worked anyway: the effect that records the tab
 * list fires on mount, and G2 starts from an EMPTY list, so the previous
 * session's record was overwritten with `[]` before anyone could ask for it
 * back. Both halves are asserted here: the record survives the launch, and the
 * click path from the rail to the hook exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readLastSessionPanels } from './lastSessionPanels.js';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const source = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

test('the previous session\'s tabs are read back, with retired panel ids migrated', () => {
  // `review` and `ci` folded into the one Pull request panel (G5); a saved
  // layout from before that must restore to a panel that still exists rather
  // than silently losing tabs.
  store.set('br-side-tabs-last', JSON.stringify(['files', 'review', 'ci', 'uitest']));
  assert.deepEqual(readLastSessionPanels(), ['files', 'stack', 'browser']);
});

test('a malformed or absent record restores nothing rather than throwing on launch', () => {
  store.delete('br-side-tabs-last');
  assert.deepEqual(readLastSessionPanels(), []);
  store.set('br-side-tabs-last', '{not json');
  assert.deepEqual(readLastSessionPanels(), []);
  store.set('br-side-tabs-last', JSON.stringify({ files: true }));
  assert.deepEqual(readLastSessionPanels(), []);
});

test('the launch write is skipped, or the clean start erases what the restore exists to bring back', () => {
  const hook = source('./usePanels.ts');
  // The record is read at init, BEFORE the tab-recording effect can run.
  assert.match(hook, /useState<PanelId\[\]>\(readLastSessionPanels\)/);
  // And the effect's first run — the mount write of the empty list — is skipped.
  assert.match(
    hook,
    /if \(!tabsRecorded\.current\) \{ tabsRecorded\.current = true; return; \}\s*\n\s*localStorage\.setItem\(LAST_SESSION_PANELS_KEY/,
  );
});

test('the restore is reachable: the rail renders it, and every layer between passes it down', () => {
  // The hook-heavy rail cannot be called outside React, so the click path is
  // asserted at the source. That is the check that was missing — the action was
  // exported and destructured and never wired to anything a person can press.
  const rail = source('../../components/layout/ViewsRail.tsx');
  assert.match(rail, /onClick=\{restoreLastSessionPanels\}/);
  assert.match(rail, /Reopen last session’s panels/);
  // Offered only when there is something to bring back.
  assert.match(rail, /lastSessionPanels\.length > 0 && !chooserQuery \?/);

  for (const [file, relative] of [
    ['MainContent', '../../App/layout/MainContent.tsx'],
    ['App', '../../App.tsx'],
  ] as const) {
    const text = source(relative);
    assert.match(text, /restoreLastSessionPanels=\{restoreLastSessionPanels\}/, `${file} does not pass the action down`);
    assert.match(text, /lastSessionPanels=\{lastSessionPanels\}/, `${file} does not pass what would be restored`);
  }
});
