import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ROUTED_B_ACCENT,
  ROUTED_B_MIN_SIZE,
  ROUTED_B_PATHS,
  routedBMarkup,
} from '../../../../packages/brand/routedB.js';

const implementationSources = [
  new URL('../../../../packages/brand/routedB.ts', import.meta.url),
  new URL('../../../../brainrouter-dashboard/components/BrainRouterLogo.tsx', import.meta.url),
  new URL('../../../../brainrouter-dashboard/app/brand/brandShared.ts', import.meta.url),
  new URL('../../settings.tsx', import.meta.url),
  new URL('../../components/layout/Sidebar.tsx', import.meta.url),
].map((url) => readFileSync(url, 'utf8')).join('\n');

test('Routed B has one canonical pair of flat path geometries', () => {
  assert.equal(Object.keys(ROUTED_B_PATHS).length, 2);
  assert.match(ROUTED_B_PATHS.upper, /^M/);
  assert.match(ROUTED_B_PATHS.lower, /^M/);
  assert.equal(ROUTED_B_MIN_SIZE, 16);
  assert.equal(ROUTED_B_ACCENT, '#7C4DFF');
});

test('16px monochrome markup is a stable, one-color source snapshot', () => {
  const markup = routedBMarkup({ x: 0, y: 0, size: 16, color: '#111111' });
  assert.equal(
    markup,
    '<g transform="translate(0 0) scale(0.666667)"><path d="M2 2H10L14 6H16C19.314 6 22 8.686 22 12H18C18 10.895 17.105 10 16 10H12.343L8.343 6H2Z" fill="#111111"/><path d="M2 22H10L14 18H16C19.314 18 22 15.314 22 12H18C18 13.105 17.105 14 16 14H12.343L8.343 18H2Z" fill="#111111"/></g>',
  );
  assert.equal(new Set([...markup.matchAll(/fill="([^"]+)"/g)].map((match) => match[1])).size, 1);
});

test('optional accent stays flat and all coded logo sources reject image effects', () => {
  const markup = routedBMarkup({ x: 2, y: 3, size: 24, color: 'currentColor', accent: ROUTED_B_ACCENT });
  assert.match(markup, /fill="currentColor"/);
  assert.match(markup, /fill="#7C4DFF"/);

  for (const forbidden of [
    /<image\b/i,
    /\bdata:image\//i,
    /\.(?:avif|gif|jpe?g|png|webp)\b/i,
    /<(?:linear|radial)Gradient\b/i,
    /\burl\(#/i,
    /background-image\s*:/i,
  ]) {
    assert.doesNotMatch(markup, forbidden);
    assert.doesNotMatch(implementationSources, forbidden);
  }
});
