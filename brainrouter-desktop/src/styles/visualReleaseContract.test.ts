import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (relative: string): string => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

const indexHtml = read('../../index.html');
const app = read('../App.tsx');
const appDialogs = read('../App/layout/AppDialogs.tsx');
const settings = read('../settings.tsx');
const hookIndex = read('../App/hooks/index.ts');
const renderPanelBody = read('../App/render/renderPanelBody.tsx');
const viewsRail = read('../components/layout/ViewsRail.tsx');
const zoom = read('../App/hooks/useZoom.ts');
const electronMain = read('../../electron/main.ts');
const browserE2E = read('../../scripts/browser-e2e.mjs');
const workflow = read('../../../.github/workflows/release-desktop.yml');
const packageJson = read('../../package.json');
const reset = read('./foundation/reset.css');
const motion = read('./foundation/motion.css');
const tokens = read('./foundation/tokens.css');
const surfaces = [
  'chat.css',
  'composer.css',
  'editorFiles.css',
  'panels.css',
  'remainingWorkbench.css',
  'settings.css',
  'terminalBrowser.css',
  'track.css',
].map((file) => [file, read(`./surfaces/${file}`)] as const);

test('the released visual system is unconditional and has no user compatibility flag', () => {
  assert.match(indexHtml, /<html[^>]*data-visual-system="v2"/);

  const runtimeSources = [app, appDialogs, settings, hookIndex].join('\n');
  assert.doesNotMatch(runtimeSources, /useVisualSystem|visualSystemV2|desktop\.visualSystemV2/);
  assert.doesNotMatch(settings, /New desktop design|Preview the redesigned native workbench/);
});

test('accessibility preferences and keyboard focus remain release contracts', () => {
  assert.match(reset, /button:focus-visible\s*\{/);
  assert.match(motion, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(motion, /animation-duration:\s*0\.01ms !important/);
  assert.match(tokens, /@media \(forced-colors: active\)/);

  for (const [name, source] of surfaces) {
    assert.match(source, /:focus-visible/, `${name} must expose keyboard focus`);
    assert.match(source, /@media \(forced-colors: active\)/, `${name} must support forced colors`);
  }

  assert.match(zoom, /export const MIN_ZOOM = 0\.5/);
  assert.match(zoom, /export const MAX_ZOOM = 2\.5/);
});

test('large workbench features remain split from the initial renderer bundle', () => {
  for (const panel of ['EditorPanel', 'CIPanel', 'BrowserPanel', 'AtlasPanel', 'WorkflowsPanel']) {
    assert.match(
      renderPanelBody,
      new RegExp(`lazy\\(\\(\\) => import\\([^\\n]+${panel}`),
      `${panel} must stay lazy`,
    );
  }
  assert.match(packageJson, /"build":\s*"[^"]*verify:visual-release"/);
  assert.match(packageJson, /"verify:visual-release":\s*"node scripts\/verify-visual-release\.mjs"/);
});

test('open side panels remain mounted while users switch workbench views', () => {
  assert.match(viewsRail, /sideTabs\.map\(\(t\) => \(/);
  assert.match(
    viewsRail,
    /style=\{\{\s*display:\s*t === activeSideTab \? undefined : 'none'\s*\}\}/,
  );
  assert.match(viewsRail, /renderPanelBody\(t,\s*t === activeSideTab\)/);
});

test('release automation preserves native macOS and Windows window ownership', () => {
  assert.match(electronMain, /titleBarStyle:\s*process\.platform === 'darwin' \? 'hiddenInset' : 'default'/);
  assert.match(workflow, /runs-on:\s*macos-14/);
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /run:\s*npm run dist:mac/);
  assert.match(workflow, /run:\s*npm run dist:win/);
  assert.match(workflow, /brainrouter-desktop\/release\/\*\.exe/);
  assert.match(workflow, /name:\s*Windows desktop contracts/);
  assert.match(workflow, /terminalShells\.test\.js/);
  assert.match(workflow, /npm rebuild electron/);
  assert.match(workflow, /NODE_OPTIONS:\s*--max-old-space-size=4096/);
  assert.match(workflow, /tags:\s*\['desktop-v\*',\s*'v\*'\]/);
  assert.doesNotMatch(workflow, /refs\/tags\/desktop-v/);
  assert.match(workflow, /include-hidden-files:\s*true/);
  assert.match(browserE2E, /retention baseline did not settle/);
});
