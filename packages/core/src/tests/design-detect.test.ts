/**
 * ADR-056 D-B1 — the deterministic design detector. Every rule has a fixture
 * that triggers it and nothing else it should not; a clean page yields zero;
 * design.md tokens make the design-system rules live; suppressions remove and
 * report; JSX normalises; line numbers point at the element; the workspace
 * collector refuses paths outside the root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectDesign, DESIGN_RULES, parseDesignTokens, parseDesignSuppressions, globMatch, isSuppressed,
  parseCss, parseColor, contrastRatio, toHex, normaliseMarkup, collectDesignFiles, readDesignSystemTokens,
} from '../design/index.js';

const page = (body: string, css = ''): string => `<!doctype html><html><head><title>t</title><style>${css}</style></head><body>${body}</body></html>`;
const rulesOf = (files: Array<{ path: string; content: string }>, opts = {}) => detectDesign(files, opts).findings.map((f) => f.rule);
const one = (html: string, css = '', opts = {}) => rulesOf([{ path: 'page.html', content: page(html, css) }], opts);

const CLEAN = page(
  `<main><h1>Orders</h1><p>Every order in the last thirty days, with its status and the customer who placed it, so a dispatcher can act on it without a second screen.</p><h2>Open</h2><label for="q">Search</label><input id="q"><button class="go">Search</button><img src="a.png" alt="A chart"></main>`,
  `body{font-family:"Cormorant Garamond",serif;font-size:16px;line-height:1.5;color:#1a1a1a;background:#fbfaf7} h1{font-size:40px} h2{font-size:24px} .go{height:44px;padding:8px 16px} .go:focus-visible{outline:2px solid #1a1a1a}`,
);

test('B1 a clean page yields no findings', () => {
  const r = detectDesign([{ path: 'clean.html', content: CLEAN }]);
  assert.deepEqual(r.findings, []);
  assert.equal(r.files, 1); assert.equal(r.errors, 0);
});

test('B1 slop rules fire on their tells', () => {
  assert.ok(one('<div class="card">x</div>', '.card{border-left:4px solid #e11d48;padding:8px}').includes('side-stripe-border'));
  assert.ok(one('<h1 class="g">Hi</h1>', '.g{background:linear-gradient(90deg,#8b5cf6,#3b82f6);-webkit-background-clip:text;color:transparent}').includes('gradient-text'));
  assert.ok(one('<section class="hero">x</section>', '.hero{background:linear-gradient(135deg,#7c3aed,#2563eb)}').includes('ai-palette'));
  assert.ok(one('<div class="c"><div class="c">inner</div></div>', '.c{border:1px solid #ccc;border-radius:8px}').includes('nested-cards'));
  assert.ok(one('<div class="k">x</div>', '.k{box-shadow:0 0 24px #7c3aed}').includes('glow-halo'));
  assert.ok(one('<div class="b">x</div>', '.b{transition:transform .3s cubic-bezier(.68,-.55,.27,1.55)}').includes('bounce-easing'));
  assert.ok(one('<span class="dot"></span>', '.dot{animation:pulse 1s infinite}').includes('pulsing-dot'));
  assert.ok(one('<marquee>news</marquee>').includes('marquee'));
  assert.ok(one('<span class="eyebrow">FEATURES</span><h2>What we do</h2>').includes('eyebrow-label'));
  assert.ok(one('<span>01</span><h2>Discover</h2>').includes('numbered-sections'));
  assert.ok(one('<div class="tile"><svg></svg></div><h3>Fast</h3>', '.tile{border-radius:12px}').includes('icon-tile-stack'));
  assert.ok(one('<p>Seamless onboarding lets you unleash productivity and supercharge every workflow.</p>').includes('buzzword-copy'));
  assert.ok(one('<p>Body text here in a heading-sized paragraph that is long enough to count as copy.</p><h1>Title</h1>', 'p{font-size:16px} h1{font-size:18px}').includes('flat-type-hierarchy'));
  assert.ok(one('<p>Copy in the default face that is long enough to be body copy for this check.</p>', 'p{font-family:Inter,sans-serif}').includes('overused-font'));
});

test('B1 identical card grid and hero metrics are advisory', () => {
  const cards = Array.from({ length: 3 }, (_, i) => `<div class="card"><svg></svg><h3>F${i}</h3><p>d</p></div>`).join('');
  const r = detectDesign([{ path: 'p.html', content: page(`<section>${cards}</section>`, '.card{border:1px solid #ddd;border-radius:8px}') }]);
  const grid = r.findings.find((f) => f.rule === 'identical-card-grid');
  assert.ok(grid?.advisory);
  assert.equal(r.warnings, 0, 'advisory findings do not count');
  const metrics = Array.from({ length: 3 }, () => `<div><strong>1,204</strong><span>Users</span></div>`).join('');
  assert.ok(one(`<section>${metrics}</section>`).includes('hero-metric'));
});

test('B1 quality rules: contrast, gray on colour, sizes, semantics, motion, targets, layout', () => {
  assert.ok(one('<p class="lc">Long enough body copy to be measured for contrast against its own background colour.</p>', '.lc{color:#777;background-color:#888}').includes('low-contrast'));
  assert.ok(one('<p class="g">Long enough body copy to be measured for the gray-on-colour rule in this fixture.</p>', '.g{color:#9a9a9a;background-color:#1d4ed8}').includes('gray-on-color'));
  assert.ok(one('<p class="t">Long enough body copy to be measured for the tiny text rule in this small fixture.</p>', '.t{font-size:10px}').includes('tiny-text'));
  assert.ok(one('<p class="l">Long enough body copy to be measured for the tight leading rule in this small fixture.</p>', '.l{line-height:1.05}').includes('tight-leading'));
  assert.ok(one('<p class="j">Long enough body copy to be measured for the justified text rule in this small fixture.</p>', '.j{text-align:justify}').includes('justified-text'));
  assert.ok(one('<p class="u">Long enough body copy to be measured for the all caps body rule in this small fixture.</p>', '.u{text-transform:uppercase}').includes('all-caps-body'));
  assert.ok(one('<p class="w">Long enough body copy to be measured for the wide tracking rule in this small fixture.</p>', '.w{letter-spacing:0.12em}').includes('wide-tracking'));
  assert.ok(one('<h1>A</h1><h3>B</h3>').includes('skipped-heading'));
  assert.ok(one('<img src="x.png">').includes('missing-alt'));
  assert.ok(one('<input name="email" placeholder="Email">').includes('unlabelled-control'));
  assert.ok(!one('<label>Email <input name="email"></label>').includes('unlabelled-control'));
  assert.ok(one('<button class="s">Go</button>', '.s{height:28px}').includes('small-touch-target'));
  assert.ok(one('<div class="wrap">x</div>', '.wrap{width:1200px}').includes('fixed-width-layout'));
  assert.ok(one('<p style="color:#ff0000">x</p>').includes('inline-color-literal'));
});

test('B1 sheet rules: focus outline removed, reduced motion ignored, marquee keyframes', () => {
  const r1 = detectDesign([{ path: 'a.css', content: 'button:focus{outline:none}' }]);
  assert.ok(r1.findings.some((f) => f.rule === 'focus-outline-removed' && f.line === 1));
  const r2 = detectDesign([{ path: 'b.css', content: 'button:focus{outline:none} button:focus-visible{outline:2px solid #000}' }]);
  assert.ok(!r2.findings.some((f) => f.rule === 'focus-outline-removed'));
  const r3 = detectDesign([{ path: 'c.css', content: '@keyframes spin{to{transform:rotate(1turn)}} .x{animation:spin 1s linear infinite}' }]);
  assert.ok(r3.findings.some((f) => f.rule === 'reduced-motion-ignored'));
  const r4 = detectDesign([{ path: 'd.css', content: '@keyframes spin{to{transform:rotate(1turn)}} .x{animation:spin 1s} @media (prefers-reduced-motion: reduce){.x{animation:none}}' }]);
  assert.ok(!r4.findings.some((f) => f.rule === 'reduced-motion-ignored'));
  const r5 = detectDesign([{ path: 'e.css', content: '@keyframes marquee{from{transform:translateX(0)}to{transform:translateX(-100%)}}' }]);
  assert.ok(r5.findings.some((f) => f.rule === 'marquee'));
});

test('B1 design.md tokens make the design-system rules live', () => {
  const tokens = parseDesignTokens(`---\nname: Demo\ncolors:\n  primary: "#b8422e"\n  paper: "#faf7f2"\ntypography:\n  display:\n    fontFamily: "Cormorant Garamond, Georgia, serif"\n  body:\n    fontFamily: "Source Sans 3, sans-serif"\nrounded:\n  sm: "4px"\n  md: "8px"\n---\n# Design\n`)!;
  assert.deepEqual([...tokens.fonts], ['cormorant garamond', 'source sans 3']);
  assert.ok(tokens.colors.has('#b8422e') && tokens.radii.has('8px'));
  const rules = one('<p class="x">Long enough body copy to be measured for the design-system rules in this fixture page.</p>', '.x{font-family:"Inter",sans-serif;color:#123456;border-radius:12px}', { tokens });
  assert.ok(rules.includes('design-system-font') && rules.includes('design-system-color') && rules.includes('design-system-radius'));
  const ok = one('<p class="x">Long enough body copy to be measured for the design-system rules in this fixture page.</p>', '.x{font-family:"Source Sans 3",sans-serif;color:#b8422e;border-radius:8px}', { tokens });
  assert.ok(!ok.some((r) => r.startsWith('design-system-')));
  assert.equal(parseDesignTokens('# no frontmatter'), null);
});

test('B1 suppressions remove findings and say why; globs are bounded', () => {
  const s = parseDesignSuppressions({ ignoreRules: ['missing-alt'], ignoreFiles: ['fixtures/**'], ignoreValues: [{ rule: 'overused-font', value: 'inter', files: ['src/overlay.html'], reason: 'the overlay owns its own scale' }] });
  const r = detectDesign([
    { path: 'src/a.html', content: page('<img src="x.png">') },
    { path: 'fixtures/b.html', content: page('<marquee>x</marquee>') },
    { path: 'src/overlay.html', content: page('<p>Long enough body copy in the default face to trigger the overused font rule here.</p>', 'p{font-family:Inter}') },
  ], { suppressions: s });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.suppressed.map((x) => [x.rule, x.reason]).sort(), [['marquee', 'ignoreFiles'], ['missing-alt', 'ignoreRules'], ['overused-font', 'the overlay owns its own scale']]);
  assert.ok(globMatch('src/**/*.tsx', 'src/a/b/c.tsx'), 'deep glob');
  assert.ok(!globMatch('src/*.tsx', 'src/a/b.tsx'), 'single-segment star stays in its segment');
  assert.ok(globMatch('*.css', 'x.css'), 'bare star');
  assert.equal(isSuppressed(s, 'overused-font', 'src/other.html', 'inter').suppressed, false, 'file-scoped value suppression stays scoped');
});

test('B1 JSX normalises to markup the engine can read; lines point at the element', () => {
  const jsx = `export function Card() {\n  return (\n    <div className="card" style={{ borderLeft: '4px solid #e11d48', padding: 8 }}>\n      <img src={logo} />\n    </div>\n  );\n}`;
  const norm = normaliseMarkup('Card.tsx', jsx);
  assert.match(norm, /class="card" style="border-left:4px solid #e11d48;padding:8px"/);
  const r = detectDesign([{ path: 'Card.tsx', content: jsx }]);
  assert.ok(r.findings.some((f) => f.rule === 'side-stripe-border' && f.line === 3));
  assert.ok(r.findings.some((f) => f.rule === 'missing-alt' && f.line === 4));
  assert.deepEqual(detectDesign([{ path: 'x.py', content: 'print(1)' }]).skipped, ['x.py']);
});

test('B1 CSS helpers: parse, colours, contrast', () => {
  const sheet = parseCss('/* c */ a{color:red;font-size:12px!important} @media (prefers-reduced-motion: reduce){.x{animation:none}} @keyframes k{to{opacity:0}}');
  assert.equal(sheet.rules.length, 2); assert.deepEqual(sheet.keyframes, ['k']); assert.equal(sheet.hasReducedMotionRule, true);
  assert.equal(sheet.rules[0].declarations[1].important, true);
  assert.equal(toHex('rgb(255, 0, 0)'), '#ff0000'); assert.equal(toHex('hsl(120, 100%, 25%)'), '#008000'); assert.equal(toHex('var(--x)'), null);
  assert.ok(Math.abs(contrastRatio(parseColor('#000')!, parseColor('#fff')!) - 21) < 0.01);
});

test('B1 the collector stays inside the workspace and skips build output', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'br-design-'));
  try {
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true }); fs.mkdirSync(path.join(ws, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'a.html'), CLEAN); fs.writeFileSync(path.join(ws, 'src', 'b.css'), 'a{}'); fs.writeFileSync(path.join(ws, 'node_modules', 'x', 'c.html'), '<p>x</p>'); fs.writeFileSync(path.join(ws, 'README.md'), '# r');
    const c = collectDesignFiles(ws, ['src', '../etc/passwd', 'README.md']);
    assert.deepEqual(c.files.map((f) => f.path), ['src/a.html', 'src/b.css']);
    assert.deepEqual(c.refused.map((r) => r.reason), ['outside the workspace', 'not a UI file (html, css, jsx/tsx, svelte, vue, astro)']);
    assert.equal(collectDesignFiles(ws).files.length, 2, 'node_modules skipped');
    fs.writeFileSync(path.join(ws, 'design.md'), '---\ncolors:\n  ink: "#111111"\n---\n');
    assert.ok(readDesignSystemTokens(ws)?.colors.has('#111111'));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('B1 every catalogue rule is exercised by the suite or is a document-level rule', () => {
  const ids = new Set(DESIGN_RULES.map((r) => r.id));
  const covered = new Set(['side-stripe-border', 'gradient-text', 'ai-palette', 'nested-cards', 'glow-halo', 'bounce-easing', 'pulsing-dot', 'marquee', 'eyebrow-label', 'numbered-sections', 'icon-tile-stack', 'buzzword-copy', 'flat-type-hierarchy', 'overused-font', 'identical-card-grid', 'hero-metric', 'low-contrast', 'gray-on-color', 'tiny-text', 'tight-leading', 'justified-text', 'all-caps-body', 'wide-tracking', 'skipped-heading', 'missing-alt', 'unlabelled-control', 'small-touch-target', 'fixed-width-layout', 'inline-color-literal', 'focus-outline-removed', 'reduced-motion-ignored', 'design-system-font', 'design-system-color', 'design-system-radius', 'em-dash-overuse']);
  // Browser-only rules (engine: 'browser') are exercised by design-browser.test.ts against a fake page audit.
  const browserOnly = new Set(DESIGN_RULES.filter((r) => r.engine === 'browser').map((r) => r.id));
  for (const id of ids) assert.ok(covered.has(id) || browserOnly.has(id), `rule ${id} has no fixture`);
  const words = Array.from({ length: 90 }, (_, i) => (i % 20 === 0 ? 'clause — clause' : 'word')).join(' ');
  assert.ok(one(`<p>${words}</p>`).includes('em-dash-overuse'));
});
