/**
 * ADR-056 D-B5 — live variants, the deterministic half: wrap writes N
 * variants into the source inside a display:contents wrapper (original first,
 * losers hidden), accept leaves exactly one clean node and a receipt naming
 * the file and lines, discard restores the file byte-identical, and both
 * refuse once the wrapper is gone. JSX gets the JSX wrapper.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { wrapVariants, acceptVariant, discardVariants, listVariantSessions, findVariantBlock, variantFlavor, DESIGN_VARIANTS_DIR } from '../design/index.js';
import { withTempWorkspaceAsync } from './_helpers.js';

const PAGE = '<!doctype html>\n<html><body>\n<header>\n  <h1 class="hero">Ship faster</h1>\n</header>\n<p>Copy.</p>\n</body></html>\n';

test('B5 wrap → cycle-ready wrapper; accept leaves one clean node with a receipt; discard is byte-identical', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    fs.mkdirSync(path.join(ws, 'src')); const file = 'src/page.html'; fs.writeFileSync(path.join(ws, file), PAGE);
    const start = PAGE.indexOf('<h1'), end = PAGE.indexOf('</h1>') + '</h1>'.length;
    const { session, receipt } = wrapVariants(ws, { file, start, end, variants: ['<h1 class="hero hero--bold">SHIP FASTER</h1>', '<h1 class="hero hero--quiet">Ship faster, quietly</h1>', '<h1 class="hero hero--display">Ship <em>faster</em></h1>'], action: 'bolder', now: () => new Date('2026-09-05T13:00:00Z') });
    assert.equal(receipt.count, 3); assert.equal(receipt.flavor, 'html'); assert.deepEqual(receipt.lines, [4, 4]);
    const wrapped = fs.readFileSync(path.join(ws, file), 'utf8');
    assert.match(wrapped, /<div style="display:contents" data-brainrouter-variants="[a-z0-9-]+" data-brainrouter-action="bolder" data-brainrouter-active="0">/);
    assert.equal((wrapped.match(/data-brainrouter-variant="/g) ?? []).length, 4, 'original + 3 variants');
    assert.equal((wrapped.match(/ hidden>/g) ?? []).length, 3, 'the losers are hidden at rest');
    assert.match(wrapped, /<!-- \/brainrouter-variants:[a-z0-9-]+ -->/);
    assert.ok(findVariantBlock(wrapped, session.id, 'html'));
    assert.ok(fs.existsSync(path.join(ws, DESIGN_VARIANTS_DIR, `${session.id}.json`)));
    assert.deepEqual(listVariantSessions(ws).map((s) => [s.id, s.count, s.action]), [[session.id, 3, 'bolder']]);
    assert.throws(() => wrapVariants(ws, { file, start, end: start + 400, variants: ['x'], action: 'again' }), /already holds a variants wrapper/);

    const accepted = acceptVariant(ws, session.id, 2);
    const final = fs.readFileSync(path.join(ws, file), 'utf8');
    assert.equal(final, PAGE.replace('<h1 class="hero">Ship faster</h1>', '<h1 class="hero hero--quiet">Ship faster, quietly</h1>'), 'exactly the chosen node, no wrapper');
    assert.deepEqual(accepted.lines, [4, 4]); assert.equal(accepted.chosen, 2); assert.equal(listVariantSessions(ws).length, 0);
    assert.throws(() => acceptVariant(ws, session.id, 1), /no variant session/);

    const again = wrapVariants(ws, { file, start: final.indexOf('<h1'), end: final.indexOf('</h1>') + 5, variants: ['<h1>Other</h1>'], action: 'quieter' });
    assert.notEqual(fs.readFileSync(path.join(ws, file), 'utf8'), final);
    const restored = discardVariants(ws, again.session.id);
    assert.equal(fs.readFileSync(path.join(ws, file), 'utf8'), final, 'discard restores byte-identical');
    assert.equal(restored.restoredBytes, Buffer.byteLength(final));
    const third = wrapVariants(ws, { file, start: final.indexOf('<h1'), end: final.indexOf('</h1>') + 5, variants: ['<h1>Z</h1>'], action: 'bolder' });
    fs.writeFileSync(path.join(ws, file), final); // someone accepted by hand / reverted
    assert.throws(() => discardVariants(ws, third.session.id), /no longer in src\/page\.html/);
    assert.throws(() => acceptVariant(ws, third.session.id, 1), /no longer in/);
    assert.throws(() => wrapVariants(ws, { file: '../outside.html', start: 0, end: 1, variants: ['x'], action: 'a' }), /outside the workspace/);
    assert.throws(() => wrapVariants(ws, { file, start: 0, end: 5, variants: [], action: 'a' }), /between 1 and 6/);
  });
});

test('B5 JSX files get the JSX wrapper and the JSX closer', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const file = 'src/Hero.tsx'; fs.mkdirSync(path.join(ws, 'src'));
    const src = 'export function Hero() {\n  return (<section><h1 className="hero">Ship faster</h1></section>);\n}\n';
    fs.writeFileSync(path.join(ws, file), src);
    assert.equal(variantFlavor(file), 'jsx');
    const start = src.indexOf('<h1'), end = src.indexOf('</h1>') + 5;
    const { session } = wrapVariants(ws, { file, start, end, variants: ['<h1 className="hero hero--bold">SHIP FASTER</h1>'], action: 'bolder' });
    const wrapped = fs.readFileSync(path.join(ws, file), 'utf8');
    assert.match(wrapped, /<div style=\{\{ display: 'contents' \}\} data-brainrouter-variants="/); assert.match(wrapped, /\{\/\* \/brainrouter-variants:[a-z0-9-]+ \*\/\}/);
    assert.ok(!/style="display:contents"/.test(wrapped), 'no string style in JSX');
    acceptVariant(ws, session.id, 1);
    assert.equal(fs.readFileSync(path.join(ws, file), 'utf8'), src.replace('<h1 className="hero">Ship faster</h1>', '<h1 className="hero hero--bold">SHIP FASTER</h1>'));
  });
});
