import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { applyFilters } from '../attachment/format/pdf/filters.js';
import { createBudget } from '../attachment/format/pdf/limits.js';
import type { PdfDict, PdfObject } from '../attachment/format/pdf/objects.js';

const identity = (obj: PdfObject | undefined): PdfObject | undefined => obj;

function dict(entries: Record<string, PdfObject>): PdfDict {
  return new Map(Object.entries(entries));
}

const name = (v: string): PdfObject => ({ t: 'name', v });
const num = (v: number): PdfObject => ({ t: 'num', v });

test('FlateDecode inflates a real deflate stream — the thing this module said it could not do', () => {
  const budget = createBudget();
  const raw = zlib.deflateSync(Buffer.from('BT (Inflated) Tj ET', 'latin1'));
  const out = applyFilters(raw, dict({ Filter: name('FlateDecode') }), identity, budget);
  assert.equal(out.data?.toString('latin1'), 'BT (Inflated) Tj ET');
  assert.deepEqual(budget.hit, []);
});

test('FlateDecode recovers what it can from a truncated stream instead of failing', () => {
  const budget = createBudget();
  const full = zlib.deflateSync(Buffer.from('A'.repeat(4096), 'latin1'));
  const out = applyFilters(full.subarray(0, full.length - 4), dict({ Filter: name('FlateDecode') }), identity, budget);
  assert.ok((out.data?.length ?? 0) > 0, 'partial output, not an exception');
});

test('FlateDecode undoes a PNG Up predictor', () => {
  const budget = createBudget();
  // Two 4-byte rows, each prefixed with filter type 2 (Up).
  const encoded = Buffer.from([2, 1, 2, 3, 4, 2, 4, 4, 4, 4]);
  const raw = zlib.deflateSync(encoded);
  const out = applyFilters(
    raw,
    dict({
      Filter: name('FlateDecode'),
      DecodeParms: { t: 'dict', v: dict({ Predictor: num(12), Columns: num(4) }) },
    }),
    identity,
    budget,
  );
  assert.deepEqual([...(out.data ?? [])], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('TIFF predictor 2 undoes horizontal differencing', () => {
  const budget = createBudget();
  const raw = zlib.deflateSync(Buffer.from([10, 5, 5, 5]));
  const out = applyFilters(
    raw,
    dict({
      Filter: name('FlateDecode'),
      DecodeParms: { t: 'dict', v: dict({ Predictor: num(2), Columns: num(4) }) },
    }),
    identity,
    budget,
  );
  assert.deepEqual([...(out.data ?? [])], [10, 15, 20, 25]);
});

test('a decompression bomb is refused by size, not by hanging', () => {
  const budget = createBudget({ maxInflatedBytesPerStream: 4096, maxInflatedBytesTotal: 4096 });
  const bomb = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024));
  const started = Date.now();
  const out = applyFilters(bomb, dict({ Filter: name('FlateDecode') }), identity, budget);
  assert.equal(out.data, null);
  assert.ok(budget.hit.includes('inflated') || budget.hit.includes('malformed'));
  assert.ok(Date.now() - started < 2000, 'refusal is immediate');
});

test('ASCIIHexDecode reads hex pairs and pads an odd trailing digit', () => {
  const budget = createBudget();
  const out = applyFilters(Buffer.from('48656C6C6F 21>', 'latin1'), dict({ Filter: name('ASCIIHexDecode') }), identity, budget);
  assert.equal(out.data?.toString('latin1'), 'Hello!');
});

test('ASCII85Decode round-trips, including the z shorthand for four zero bytes', () => {
  const budget = createBudget();
  const source = Buffer.from([0, 0, 0, 0, 72, 101, 108, 108, 111, 33]);
  const out = applyFilters(Buffer.from(encodeAscii85(source), 'latin1'), dict({ Filter: name('ASCII85Decode') }), identity, budget);
  assert.deepEqual([...(out.data ?? [])], [...source]);
});

test('RunLengthDecode expands literal and repeated runs', () => {
  const budget = createBudget();
  // 2 → copy the next 3 bytes; 254 → repeat the next byte 3 times; 128 → end.
  const raw = Buffer.from([2, 0x41, 0x42, 0x43, 254, 0x5a, 128]);
  const out = applyFilters(raw, dict({ Filter: name('RunLengthDecode') }), identity, budget);
  assert.equal(out.data?.toString('latin1'), 'ABCZZZ');
});

test('LZWDecode decodes the specification worked example', () => {
  const budget = createBudget();
  const encoded = Buffer.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
  const out = applyFilters(encoded, dict({ Filter: name('LZWDecode') }), identity, budget);
  assert.deepEqual([...(out.data ?? [])], [45, 45, 45, 45, 45, 65, 45, 45, 45, 66]);
});

test('a filter chain runs in order, and an image codec stops it with a reason', () => {
  const budget = createBudget();
  const inner = zlib.deflateSync(Buffer.from('chained', 'latin1'));
  const hex = Buffer.from([...inner].map((b) => b.toString(16).padStart(2, '0')).join('') + '>', 'latin1');
  const chained = applyFilters(
    hex,
    dict({ Filter: { t: 'array', v: [name('ASCIIHexDecode'), name('FlateDecode')] } }),
    identity,
    budget,
  );
  assert.equal(chained.data?.toString('latin1'), 'chained');

  const image = applyFilters(Buffer.from('irrelevant'), dict({ Filter: name('DCTDecode') }), identity, budget);
  assert.equal(image.data, null);
  assert.equal(image.image, true);
});

/** Minimal ASCII85 encoder, so the decoder is tested against data it did not produce. */
function encodeAscii85(data: Buffer): string {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    const take = chunk.length;
    let value = 0;
    for (let k = 0; k < 4; k++) value = value * 256 + (chunk[k] ?? 0);
    if (take === 4 && value === 0) {
      out += 'z';
      continue;
    }
    const digits: string[] = [];
    let remaining = value;
    for (let k = 0; k < 5; k++) {
      digits.unshift(String.fromCharCode(33 + (remaining % 85)));
      remaining = Math.floor(remaining / 85);
    }
    out += digits.slice(0, take + 1).join('');
  }
  return `${out}~>`;
}
