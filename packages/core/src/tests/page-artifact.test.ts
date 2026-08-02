/**
 * ADR-027 D10 (P7-1/P7-2) — page reads as durable, citable artifacts.
 *
 * The failures worth testing are the SILENT ones. A relative link stored away
 * from its origin still looks like a link. Two sections sharing an anchor still
 * resolve — to possibly the wrong place. Both produce a citation that appears
 * checkable and is not, which is worse than having no citation at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  absolutizeUrls,
  sliceIntoSections,
  buildPageArtifact,
  resolveCitation,
} from '../browser/pageArtifact.js';

const BASE = 'https://example.com/docs/guide/';

test('relative links and images resolve against the page URL', () => {
  const out = absolutizeUrls('See [auth](../auth) and ![logo](img/logo.png).', BASE);
  assert.match(out, /\(https:\/\/example\.com\/docs\/auth\)/);
  assert.match(out, /\(https:\/\/example\.com\/docs\/guide\/img\/logo\.png\)/);
});

test('root-relative links resolve against the origin, not the path', () => {
  const out = absolutizeUrls('[home](/index.html)', BASE);
  assert.match(out, /\(https:\/\/example\.com\/index\.html\)/);
});

test('absolute, protocol-relative, and non-navigational URLs are left alone', () => {
  // Rewriting a data: URI against a base would corrupt it.
  const input = '[a](https://other.test/x) [b](//cdn.test/y) [c](mailto:x@y.z) [d](#frag) ![e](data:image/png;base64,AAA)';
  assert.equal(absolutizeUrls(input, BASE), input);
});

test('link titles survive absolutization', () => {
  const out = absolutizeUrls('[auth](../auth "Auth guide")', BASE);
  assert.equal(out, '[auth](https://example.com/docs/auth "Auth guide")');
});

test('an unusable base returns the markdown untouched rather than fabricating links', () => {
  const input = '[a](../x)';
  assert.equal(absolutizeUrls(input, 'not a url'), input);
});

test('content before the first heading is still citable', () => {
  const sections = sliceIntoSections('Intro prose here.\n\n## Details\n\nMore.', 'My Page');
  assert.equal(sections[0]!.heading, 'My Page');
  assert.equal(sections[0]!.depth, 0);
  assert.equal(sections[0]!.content, 'Intro prose here.');
  assert.equal(sections[1]!.heading, 'Details');
  assert.equal(sections[1]!.depth, 2);
});

test('an empty lead section is dropped rather than emitted blank', () => {
  const sections = sliceIntoSections('## First\n\nBody.', 'My Page');
  assert.equal(sections.length, 1);
  assert.equal(sections[0]!.heading, 'First');
});

test('duplicate headings get distinct anchors', () => {
  // Two sections sharing an anchor make a citation ambiguous — it still
  // resolves, just possibly to the wrong section.
  const sections = sliceIntoSections('## Overview\n\nA.\n\n## Overview\n\nB.', 'T');
  assert.deepEqual(sections.map((s) => s.anchor), ['overview', 'overview-2']);
  assert.equal(sections[0]!.content, 'A.');
  assert.equal(sections[1]!.content, 'B.');
});

test('a # inside fenced code is not treated as a heading', () => {
  // Otherwise a shell snippet shatters the document at arbitrary points.
  const md = ['## Setup', '', '```bash', '# install deps', 'npm ci', '```', '', 'Done.'].join('\n');
  const sections = sliceIntoSections(md, 'T');
  assert.equal(sections.length, 1);
  assert.match(sections[0]!.content, /# install deps/);
  assert.match(sections[0]!.content, /Done\./);
});

test('headings that are only punctuation still yield a usable anchor', () => {
  const sections = sliceIntoSections('## ***\n\nBody.', 'T');
  assert.equal(sections[0]!.anchor, 'section');
});

test('an artifact carries provenance and resolvable sections', () => {
  const artifact = buildPageArtifact({
    title: 'Auth Guide',
    url: 'https://example.com/docs/guide/',
    markdown: '## Tokens\n\nSee [rotation](../rotate).',
    fetchedAt: '2026-08-01T10:00:00.000Z',
  });
  assert.equal(artifact.title, 'Auth Guide');
  assert.equal(artifact.fetchedAt, '2026-08-01T10:00:00.000Z');
  assert.match(artifact.markdown, /https:\/\/example\.com\/docs\/rotate/,
    'links are absolutized before storage, while the base is still known');

  const cited = resolveCitation(artifact, '#tokens');
  assert.ok(cited);
  assert.equal(cited.heading, 'Tokens');
});

test('an unknown anchor resolves to null, never to the nearest section', () => {
  const artifact = buildPageArtifact({
    title: 'T', url: 'https://example.com/', markdown: '## A\n\nx.', fetchedAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(resolveCitation(artifact, '#b'), null,
    'a citation that silently resolves elsewhere is the failure anchors prevent');
  assert.ok(resolveCitation(artifact, 'a'), 'a bare anchor works too');
});

test('an empty title falls back to the URL rather than an empty string', () => {
  const artifact = buildPageArtifact({
    title: '   ', url: 'https://example.com/x', markdown: 'body', fetchedAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(artifact.title, 'https://example.com/x');
});
