import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const theme = fs.readFileSync(new URL('../../theme.css', import.meta.url), 'utf8');
const surfaces = fs.readFileSync(new URL('./remainingWorkbench.css', import.meta.url), 'utf8');
const workflows = fs.readFileSync(new URL('../../panels/planning/WorkflowsPanel.tsx', import.meta.url), 'utf8');
const atlas = fs.readFileSync(new URL('../../panels/atlas/AtlasPanel.tsx', import.meta.url), 'utf8');
const atlasModel = fs.readFileSync(new URL('../../panels/AtlasPanel/atlasModel.ts', import.meta.url), 'utf8');

test('the ordered theme manifest includes remaining workbench surfaces', () => {
  assert.match(theme, /@import "\.\/styles\/surfaces\/remainingWorkbench\.css";/);
});

test('remaining workbench styling is preview-scoped and semantic-token-only', () => {
  assert.match(surfaces, /html\[data-visual-system="v2"\]/);
  assert.doesNotMatch(surfaces, /#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(surfaces, /\b(?:rgb|rgba|hsl|hsla)\(/i);
  assert.doesNotMatch(surfaces, /linear-gradient\(/i);
});

test('Atlas, workflows, meetings, review, and CI use flat accessible surfaces', () => {
  assert.match(surfaces, /\.atlas-detail\s*\{[\s\S]*?border-radius:\s*0/);
  assert.match(surfaces, /\.wf-node:hover\s*\{[\s\S]*?transform:\s*none/);
  assert.match(surfaces, /\.mv-card,[\s\S]*?box-shadow:\s*none/);
  assert.match(surfaces, /\.review-finding,[\s\S]*?transform:\s*none/);
  assert.match(surfaces, /@media \(forced-colors: active\)/);
});

test('workflow map chrome uses semantic tokens instead of an inline literal mask', () => {
  assert.match(workflows, /maskColor="var\(--shell-interaction-selected\)"/);
  assert.doesNotMatch(workflows, /maskColor="rgba\(/);
});

test('Atlas frames virtualized nodes on mount and uses semantic map chrome', () => {
  assert.match(atlas, /onInit=\{\(inst\) => \{[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?inst\.fitView\(\{/);
  assert.match(atlas, /nodes:\s*rfNodes\.map\(\(n\) => \(\{ id: n\.id \}\)\)/);
  assert.match(atlas, /initialWidth:\s*b\.width,[\s\S]*?initialHeight:\s*b\.height/);
  assert.match(atlasModel, /initialWidth:\s*cardW,[\s\S]*?initialHeight:\s*cardH/);
  assert.match(atlasModel, /initialWidth:\s*152,[\s\S]*?initialHeight:\s*34/);
  assert.match(atlas, /maskColor="var\(--shell-interaction-selected\)"/);
  assert.doesNotMatch(atlas, /maskColor="rgba\(/);
});
