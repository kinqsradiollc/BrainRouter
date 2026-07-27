/**
 * Google SERP parsing — web_search now navigates the in-app browser to Google
 * first (real Chromium renders its JS results) and parses the rendered HTML,
 * falling back to DuckDuckGo. The parser is structural (title <h3> inside the
 * result anchor) so it survives Google's churning CSS class names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleHtml, unwrapGoogleUrl, isGoogleInternal, googleSearchUrl } from '../websearch/providers/google.js';

test('unwrapGoogleUrl decodes the /url?q= redirect and passes direct hrefs through', () => {
  assert.equal(
    unwrapGoogleUrl('/url?q=https://blog.example/post&sa=U&ved=xyz'),
    'https://blog.example/post',
  );
  assert.equal(unwrapGoogleUrl('https://direct.example/x'), 'https://direct.example/x');
});

test('isGoogleInternal flags Google properties and passes real hosts', () => {
  for (const u of ['https://www.google.com/search?q=x', 'https://google.co.uk/maps', 'https://ssl.gstatic.com/i.png', 'https://webcache.googleusercontent.com/y']) {
    assert.equal(isGoogleInternal(u), true, u);
  }
  for (const u of ['https://news.example/a', 'https://en.wikipedia.org/wiki/T', 'https://youtube.com/watch']) {
    assert.equal(isGoogleInternal(u), false, u);
  }
});

test('parseGoogleHtml extracts ranked results, unwraps /url?q=, drops Google-internal', () => {
  const html = `
    <div class="g" data-hveid="a">
      <a href="https://news.example/story-a"><br><h3 class="LC20lb">First Result</h3></a>
      <div class="VwiC3b">A detailed snippet describing the first story clearly.</div>
    </div>
    <div class="g" data-hveid="b">
      <a href="/url?q=https://blog.example/post-b&sa=U&ved=z"><h3>Second Result</h3></a>
      <div data-sncf="1">Second snippet text that is plenty long enough.</div>
    </div>
    <div class="g" data-hveid="c">
      <a href="https://www.google.com/search?q=related"><h3>Internal Google Link</h3></a>
    </div>`;
  const out = parseGoogleHtml(html, 10);
  assert.equal(out.length, 2, 'google-internal result dropped');
  assert.equal(out[0].title, 'First Result');
  assert.equal(out[0].url, 'https://news.example/story-a');
  assert.match(out[0].snippet, /detailed snippet/);
  assert.equal(out[1].url, 'https://blog.example/post-b', 'unwrapped /url?q= redirect');
  assert.ok(!out.some((r) => /google\.com/.test(r.url)), 'no google.com URLs');
});

test('parseGoogleHtml respects the result limit and dedupes repeated URLs', () => {
  const block = (i: number) => `<div class="g"><a href="https://e.test/${i}"><h3>T${i}</h3></a><div class="VwiC3b">s${i} long enough snippet</div></div>`;
  const dup = `<div class="g"><a href="https://e.test/0"><h3>Dup</h3></a><div class="VwiC3b">dup snippet long enough</div></div>`;
  const html = Array.from({ length: 8 }, (_v, i) => block(i)).join('') + dup;
  assert.equal(parseGoogleHtml(html, 3).length, 3, 'limit respected');
  assert.equal(parseGoogleHtml(html, 20).length, 8, 'duplicate URL not counted twice');
});

test('googleSearchUrl leaves language and region to the browser session', () => {
  const u = new URL(googleSearchUrl('current ai news', 5));
  assert.equal(u.hostname, 'www.google.com');
  assert.equal(u.pathname, '/search');
  assert.equal(u.searchParams.get('q'), 'current ai news');
  assert.equal(u.searchParams.get('hl'), null);
  assert.equal(u.searchParams.get('gl'), null);
  assert.equal(u.searchParams.get('pws'), '0');
});
