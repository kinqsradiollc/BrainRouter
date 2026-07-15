import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const theme = readFileSync(new URL('../../theme.css', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../../components/layout/Sidebar.tsx', import.meta.url), 'utf8');

test('the sidebar collapse control is the first coded control after the macOS traffic lights', () => {
  const collapse = sidebar.indexOf('aria-label="Collapse sidebar"');
  const brand = sidebar.indexOf('data-brand-mark="routed-b"');
  assert.ok(collapse >= 0 && brand >= 0 && collapse < brand);
  assert.match(
    theme,
    /\[data-os="mac"\]\s+\.rail-top\s*\{[^}]*padding-left:\s*var\(--window-controls-inline-end\)/,
  );
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
