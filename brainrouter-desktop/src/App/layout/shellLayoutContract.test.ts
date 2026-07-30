import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const theme = readFileSync(new URL('../../theme.css', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../../components/layout/Sidebar.tsx', import.meta.url), 'utf8');
const activityBar = readFileSync(new URL('../../components/layout/ActivityBar.tsx', import.meta.url), 'utf8');

test('sidebar collapse lives on the activity bar only; the rail keeps traffic-light clearance', () => {
  // ONE collapse control (on the activity bar) — the rail's duplicate button
  // and its brand mark were deliberately removed to cut chrome redundancy.
  assert.ok(/Hide sidebar/.test(activityBar) && /setRailOpen/.test(activityBar));
  assert.equal(sidebar.indexOf('aria-label="Collapse sidebar"'), -1);
  assert.equal(sidebar.indexOf('data-brand-mark="routed-b"'), -1);
  // macOS window-control clearance survives on both leftmost surfaces.
  assert.match(
    theme,
    /\[data-os="mac"\]\s+\.rail-top\s*\{[^}]*padding-left:\s*var\(--window-controls-inline-end\)/,
  );
  assert.match(theme, /\[data-os="mac"\]\s+\.activity-bar\s*\{[^}]*padding-top/);
});

test('narrow layouts keep every drawer and topbar reopen control reachable', () => {
  assert.doesNotMatch(
    theme,
    /\.workrow\s*>\s*\.views-rail\s*,\s*\.workrow\s*>\s*\.env-col\s*\{[^}]*display:\s*none/i,
  );
  assert.doesNotMatch(
    theme,
    /\.topbar-right[^{}]*\{[^}]*display:\s*none\s*!important/i,
  );
  assert.match(theme, /\.env-col\.drawer\s*\{/);
  assert.match(theme, /@media\s*\(max-width:\s*920px\)[\s\S]*\.views-rail:not\(\.fullscreen\)/);
});

test('workbench chrome controls share one explicit geometry token', () => {
  assert.match(theme, /--chrome-control-size:\s*var\(--control-size\)/);
  assert.match(theme, /\.rail-top\s+\.icon-btn[\s\S]*width:\s*var\(--chrome-control-size\)/);
  assert.match(theme, /\.settings-actions\s+\.icon-btn\s*\{[^}]*width:\s*var\(--chrome-control-size\)[^}]*height:\s*var\(--chrome-control-size\)/);
});
