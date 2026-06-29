import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMonacoHex, normalizedColorToHex } from './monacoColor.js';

test('isMonacoHex accepts 3/4/6/8-digit hex, rejects everything else', () => {
  for (const ok of ['#fff', '#ffff', '#0c0c0e', '#58a6ff33', '#00000000']) assert.ok(isMonacoHex(ok), ok);
  // hsl/rgb/named/short — the exact shapes Monaco's parser throws on.
  for (const no of ['hsl(0, 0%, 96%)', 'rgb(1,2,3)', 'red', '#ff', '#12345', '#1234567', '']) {
    assert.ok(!isMonacoHex(no), no);
  }
});

test('normalizedColorToHex passes hex through unchanged (incl. alpha)', () => {
  assert.equal(normalizedColorToHex('#0c0c0e', '#000000'), '#0c0c0e');
  assert.equal(normalizedColorToHex('#58a6ff33', '#000000'), '#58a6ff33');
});

test('normalizedColorToHex converts opaque rgb/rgba → #rrggbb', () => {
  assert.equal(normalizedColorToHex('rgb(110, 118, 129)', '#000000'), '#6e7681');
  assert.equal(normalizedColorToHex('rgba(0, 0, 0, 1)', '#000000'), '#000000');
});

test('normalizedColorToHex folds alpha into #rrggbbaa (rounds) — matches theme literals', () => {
  // These are the exact scrollbar slider colors baked into the dark theme.
  assert.equal(normalizedColorToHex('rgba(110, 118, 129, 0.2)', '#000000'), '#6e768133');
  assert.equal(normalizedColorToHex('rgba(110, 118, 129, 0.3)', '#000000'), '#6e76814d');
  assert.equal(normalizedColorToHex('rgba(110, 118, 129, 0.45)', '#000000'), '#6e768173');
});

test('normalizedColorToHex clamps out-of-range channels', () => {
  assert.equal(normalizedColorToHex('rgb(999, -5, 128)', '#000000'), '#ff0080');
});

test('normalizedColorToHex falls back on unparseable input', () => {
  assert.equal(normalizedColorToHex('not-a-color', '#123456'), '#123456');
  assert.equal(normalizedColorToHex('rgb(x, y, z)', '#123456'), '#123456');
  assert.equal(normalizedColorToHex('', '#123456'), '#123456');
});
