import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlaceholderSvg,
  placeholderSvgDataUri,
  inlinePlaceholders,
} from '../prototype/placeholderRender.js';
import { makePlaceholderToken, findPlaceholderTokens } from '../prototype/protoDetect.js';

test('buildPlaceholderSvg: self-contained animated SVG with the label + accent', () => {
  const svg = buildPlaceholderSvg('hero', { color: '#4f46e5', width: 600, height: 200 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /width="600" height="200"/);
  assert.match(svg, /<animate /); // animated
  assert.match(svg, /#4f46e5/);
  assert.match(svg, />hero…</);
  assert.ok(!/<script/i.test(svg), 'no scripts');
  // no external resource loads — the only http URI allowed is the SVG namespace
  assert.ok(!/(?:href|src)\s*=/i.test(svg), 'no href/src external refs');
  assert.equal(svg.replace('http://www.w3.org/2000/svg', '').match(/https?:/i), null, 'no http(s) beyond the xmlns');
});

test('buildPlaceholderSvg: invalid color + out-of-range dims fall back to defaults', () => {
  const svg = buildPlaceholderSvg('x', { color: 'periwinkle', width: -10, height: 0 });
  assert.match(svg, /#6366f1/); // default accent
  assert.match(svg, /width="1" height="1"/); // clamped to the floor
});

test('buildPlaceholderSvg: escapes XML-special characters in the label', () => {
  const svg = buildPlaceholderSvg('id', { label: 'A & B <hero>' });
  assert.match(svg, /A &amp; B &lt;hero&gt;…/);
  assert.ok(!svg.includes('<hero>'), 'raw angle brackets are escaped');
});

test('placeholderSvgDataUri: usable img src', () => {
  const uri = placeholderSvgDataUri('avatar');
  assert.match(uri, /^data:image\/svg\+xml,/);
  assert.ok(uri.includes(encodeURIComponent('avatar')) || uri.includes('avatar'), 'carries the label');
});

test('inlinePlaceholders: swaps every token, leaves none behind', () => {
  const html = `<img src="${makePlaceholderToken('hero')}"><img src="${makePlaceholderToken('avatar')}"><img src="${makePlaceholderToken('hero')}">`;
  const out = inlinePlaceholders(html);
  assert.deepEqual(findPlaceholderTokens(out), [], 'no pending tokens remain');
  assert.equal((out.match(/data:image\/svg\+xml,/g) ?? []).length, 3, 'all three occurrences resolved');
});

test('inlinePlaceholders: idempotent on a document with no tokens', () => {
  const html = '<h1>done</h1>';
  assert.equal(inlinePlaceholders(html), html);
});
