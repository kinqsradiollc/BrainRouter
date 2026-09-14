/**
 * ADR-044 M1 — the structured-markdown floor.
 *
 * The property under test is that page STRUCTURE survives the read: a table
 * stays a table (or says it could not), a link keeps a resolvable href, a code
 * block keeps its fence, and headings/lists keep their markers. The old
 * `$('body').text()` flatten passed none of these — it is the failure this
 * module exists to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown } from '../websearch/htmlToMarkdown.js';

const md = (html: string, url = 'https://ex.test/docs/page'): string =>
  htmlToMarkdown(html, url, 15_000).markdown;

test('headings, paragraphs, and inline emphasis become markdown', () => {
  const out = md('<body><h2>Setup</h2><p>Run <b>make</b> then <em>test</em>.</p></body>');
  assert.match(out, /^## Setup$/m);
  assert.match(out, /Run \*\*make\*\* then \*test\*\./);
});

test('the title is read from <title>', () => {
  const { title } = htmlToMarkdown('<html><head><title>  Guide </title></head><body><p>x</p></body></html>', 'https://ex.test', 100);
  assert.equal(title, 'Guide');
});

test('a rectangular table survives as a GFM pipe table', () => {
  const out = md(
    '<body><table><thead><tr><th>Param</th><th>Default</th></tr></thead>' +
      '<tbody><tr><td>timeout</td><td>30</td></tr><tr><td>retries</td><td>3</td></tr></tbody></table></body>',
  );
  assert.match(out, /\| Param \| Default \|/);
  assert.match(out, /\| --- \| --- \|/);
  assert.match(out, /\| timeout \| 30 \|/);
  assert.match(out, /\| retries \| 3 \|/);
});

test('a merged-cell table is refused, not flattened under the wrong headers', () => {
  const out = md(
    '<body><table><tr><th>A</th><th>B</th></tr>' +
      '<tr><td colspan="2">spans two</td></tr></table></body>',
  );
  assert.match(out, /\*\*Table omitted\*\*/);
  assert.match(out, /merged cells/);
  // The page URL is cited so the reader can go see what was omitted.
  assert.match(out, /ex\.test/);
});

test('links keep an ABSOLUTE href, resolved against the page', () => {
  const out = md('<body><p>See <a href="/ref/api">the API</a>.</p></body>', 'https://ex.test/docs/page');
  assert.match(out, /\[the API\]\(https:\/\/ex\.test\/ref\/api\)/);
});

test('images become markdown image syntax with absolutized src', () => {
  const out = md('<body><p><img src="../img/logo.png" alt="Logo"></p></body>', 'https://ex.test/docs/page');
  assert.match(out, /!\[Logo\]\(https:\/\/ex\.test\/img\/logo\.png\)/);
});

test('a <pre><code> block is fenced, with a language hint, and keeps its whitespace', () => {
  const out = md('<body><pre><code class="language-ts">const x = 1;\n  return x;</code></pre></body>');
  assert.match(out, /```ts\nconst x = 1;\n {2}return x;\n```/);
});

test('inline <code> is backticked without a fence', () => {
  const out = md('<body><p>Call <code>fetch()</code> first.</p></body>');
  assert.match(out, /Call `fetch\(\)` first\./);
});

test('ordered and unordered lists keep their markers', () => {
  const ul = md('<body><ul><li>alpha</li><li>beta</li></ul></body>');
  assert.match(ul, /^- alpha$/m);
  assert.match(ul, /^- beta$/m);
  const ol = md('<body><ol><li>first</li><li>second</li></ol></body>');
  assert.match(ol, /^1\. first$/m);
  assert.match(ol, /^2\. second$/m);
});

test('main-content isolation drops site chrome around <main>', () => {
  const out = md(
    '<body><nav>Home About</nav><main><h1>The Article</h1>' +
      '<p>' + 'real content '.repeat(30) + '</p></main><footer>Copyright</footer></body>',
  );
  assert.match(out, /# The Article/);
  assert.doesNotMatch(out, /Home About|Copyright/);
});

test('a tiny <main> shell does not starve a content-rich body', () => {
  // An empty semantic shell must not win over the body that holds the article.
  const out = md('<body><main></main><article><p>' + 'the real body text '.repeat(30) + '</p></article></body>');
  assert.match(out, /the real body text/);
});

test('script/style/noscript are never emitted', () => {
  const out = md('<body><script>evil()</script><style>.a{}</style><p>ok</p></body>');
  assert.equal(out, 'ok');
});

test('an empty document yields empty markdown, the caller\'s signal to fall back', () => {
  assert.equal(md('<html></html>'), '');
  assert.equal(md('<body>   </body>'), '');
  // Bare text is wrapped in a body by the parser and survives as a paragraph.
  assert.equal(md('not even html'), 'not even html');
});

test('a blockquote is prefixed line by line', () => {
  const out = md('<body><blockquote><p>quoted line</p></blockquote></body>');
  assert.match(out, /^> quoted line$/m);
});

test('pathologically deep nesting degrades to text instead of overflowing the stack (ADR-044 M5)', () => {
  // Thousands of nested <div>s would blow the recursive walk's stack without the
  // depth ceiling. It must not throw, and the inner content must survive (flattened).
  const depth = 6000;
  const html = `<body>${'<div>'.repeat(depth)}deep content here${'</div>'.repeat(depth)}</body>`;
  let out = '';
  assert.doesNotThrow(() => { out = md(html); });
  assert.match(out, /deep content here/);
});

test('deep inline nesting also degrades safely', () => {
  const depth = 6000;
  const html = `<body><p>${'<span>'.repeat(depth)}x${'</span>'.repeat(depth)}</p></body>`;
  assert.doesNotThrow(() => { md(html); });
});
