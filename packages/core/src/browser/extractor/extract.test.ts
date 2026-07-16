import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFile, buildManifest, __setForceNoTsForTests } from './extract.js';
import { SHARED_SCREEN_ID } from './screen.js';
import { UiMapSchema } from '../schema.js';
import { LOGIN_TSX, WIDGET_TSX } from '../__fixtures__/sample.js';

test('extractFile finds string and expression-wrapped testIDs', () => {
  const { degraded, sites } = extractFile('src/pages/Login.tsx', LOGIN_TSX);
  assert.equal(degraded, false);
  const ids = sites.map((s) => s.testID).sort();
  assert.deepEqual(ids, ['email-field', 'forgot-link', 'login-error', 'login-submit', 'password-field']);
  // expression-wrapped {"login-submit"} resolved, and onClick detected
  const submit = sites.find((s) => s.testID === 'login-submit')!;
  assert.equal(submit.jsxTag, 'button');
  assert.equal(submit.hasOnClick, true);
  // href link detected
  const forgot = sites.find((s) => s.testID === 'forgot-link')!;
  assert.equal(forgot.hasHref, true);
  // role captured
  const err = sites.find((s) => s.testID === 'login-error')!;
  assert.equal(err.role, 'alert');
  // 1-based line + enclosing component
  assert.ok(submit.line > 1);
  assert.equal(submit.enclosingComponent, 'LoginScreen');
  // Capitalized enclosing function → component kind
  assert.equal(submit.symbolKind, 'component');
});

// A file exercising every enclosing-symbol kind: a class, a Capitalized component
// function, a lowercase helper arrow, and a top-level (no enclosing symbol) element.
const KINDS_TSX = `
class Panel {
  render() {
    return <button data-testid="cls-btn">X</button>;
  }
}
function LoginScreen() {
  return <button data-testid="cmp-btn">Y</button>;
}
const renderRow = () => <a data-testid="fn-link" href="/x">Z</a>;
const topEl = <input data-testid="top-input" />;
`;

test('extractFile classifies the enclosing symbol kind', () => {
  const { sites } = extractFile('src/components/Widget.tsx', KINDS_TSX);
  const byId = Object.fromEntries(sites.map((s) => [s.testID, s]));
  assert.equal(byId['cls-btn'].symbolKind, 'class');
  assert.equal(byId['cmp-btn'].symbolKind, 'component');
  assert.equal(byId['fn-link'].symbolKind, 'function');
  assert.equal(byId['top-input'].symbolKind, undefined); // no enclosing named symbol
});

test('assembleManifest maps symbolKind to element.kind (feature when top-level)', () => {
  const { manifest } = buildManifest([{ path: 'src/components/Widget.tsx', text: KINDS_TSX }], {
    now: '2026-06-29T00:00:00.000Z',
  });
  const byId = Object.fromEntries(manifest.screens.flatMap((s) => s.elements).map((e) => [e.testID, e]));
  assert.equal(byId['cls-btn'].kind, 'class');
  assert.equal(byId['cmp-btn'].kind, 'component');
  assert.equal(byId['cmp-btn'].component, 'LoginScreen');
  assert.equal(byId['fn-link'].kind, 'function');
  assert.equal(byId['top-input'].kind, 'feature'); // symbolKind undefined → feature
});

test('buildManifest maps a pages/ file to a screen with inferred types/actions', () => {
  const { manifest } = buildManifest([{ path: 'src/pages/Login.tsx', text: LOGIN_TSX }], {
    now: '2026-06-29T00:00:00.000Z',
  });
  // validates against the schema (AC2)
  UiMapSchema.parse(manifest);
  assert.equal(manifest.screens.length, 1);
  const login = manifest.screens[0];
  assert.equal(login.id, 'login');
  assert.equal(login.title, 'Login');
  assert.equal(login.route, '/login');
  const byId = Object.fromEntries(login.elements.map((e) => [e.testID, e]));
  assert.deepEqual({ type: byId['email-field'].type, action: byId['email-field'].action }, { type: 'input', action: 'type' });
  assert.deepEqual({ type: byId['login-submit'].type, action: byId['login-submit'].action }, { type: 'button', action: 'tap' });
  assert.deepEqual({ type: byId['forgot-link'].type, action: byId['forgot-link'].action }, { type: 'link', action: 'navigate' });
});

test('buildManifest routes non-screen files into the shared screen', () => {
  const { manifest } = buildManifest([{ path: 'src/components/Toolbar.tsx', text: WIDGET_TSX }], {
    now: '2026-06-29T00:00:00.000Z',
  });
  assert.equal(manifest.screens.length, 1);
  assert.equal(manifest.screens[0].id, SHARED_SCREEN_ID);
  const ids = manifest.screens[0].elements.map((e) => e.testID).sort();
  assert.deepEqual(ids, ['brand', 'cta', 'env-picker']);
  const byId = Object.fromEntries(manifest.screens[0].elements.map((e) => [e.testID, e]));
  // role=button override on a span
  assert.deepEqual({ type: byId['brand'].type, action: byId['brand'].action }, { type: 'button', action: 'tap' });
  // select tag
  assert.equal(byId['env-picker'].type, 'select');
});

test('buildManifest is deterministic — screens and elements sorted', () => {
  const a = buildManifest(
    [
      { path: 'src/pages/Login.tsx', text: LOGIN_TSX },
      { path: 'src/components/Toolbar.tsx', text: WIDGET_TSX },
    ],
    { now: '2026-06-29T00:00:00.000Z' },
  ).manifest;
  const b = buildManifest(
    [
      { path: 'src/components/Toolbar.tsx', text: WIDGET_TSX },
      { path: 'src/pages/Login.tsx', text: LOGIN_TSX },
    ],
    { now: '2026-06-29T00:00:00.000Z' },
  ).manifest;
  assert.deepEqual(a, b);
});

test('degraded path: no typescript → empty manifest flagged degraded', () => {
  __setForceNoTsForTests(true);
  try {
    const { manifest, degraded } = buildManifest([{ path: 'src/pages/Login.tsx', text: LOGIN_TSX }], {
      now: '2026-06-29T00:00:00.000Z',
    });
    assert.equal(degraded, true);
    assert.equal(manifest.degraded, true);
    assert.equal(manifest.screens.length, 0);
  } finally {
    __setForceNoTsForTests(false);
  }
});
