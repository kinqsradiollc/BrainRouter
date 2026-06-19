import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffImage } from './imageMeta.js';

/** Build a minimal valid PNG header (signature + IHDR chunk with w/h). */
function pngHeader(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25); // 4 len + 4 type + 13 data + 4 crc
  ihdr.writeUInt32BE(13, 0); // IHDR data length
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8); // width  -> absolute offset 16
  ihdr.writeUInt32BE(height, 12); // height -> absolute offset 20
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // color type (RGBA)
  // CRC (21..24) left as zero — sniffImage does not validate it.
  return Buffer.concat([sig, ihdr]);
}

/** Build a minimal GIF89a header (signature + logical screen w/h). */
function gifHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'latin1');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** Build a minimal BMP header (BM + BITMAPINFOHEADER width/height). */
function bmpHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(26);
  buf.write('BM', 0, 'latin1');
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return buf;
}

test('sniffImage: PNG signature → mime + dimensions', () => {
  const meta = sniffImage(pngHeader(640, 480));
  assert.ok(meta);
  assert.equal(meta.mime, 'image/png');
  assert.equal(meta.width, 640);
  assert.equal(meta.height, 480);
});

test('sniffImage: GIF89a → little-endian dimensions', () => {
  const meta = sniffImage(gifHeader(120, 90));
  assert.ok(meta);
  assert.equal(meta.mime, 'image/gif');
  assert.equal(meta.width, 120);
  assert.equal(meta.height, 90);
});

test('sniffImage: GIF87a signature is recognized', () => {
  const buf = gifHeader(8, 8);
  buf.write('GIF87a', 0, 'latin1');
  const meta = sniffImage(buf);
  assert.ok(meta);
  assert.equal(meta.mime, 'image/gif');
  assert.equal(meta.width, 8);
  assert.equal(meta.height, 8);
});

test('sniffImage: BMP → little-endian int32 dimensions', () => {
  const meta = sniffImage(bmpHeader(256, 128));
  assert.ok(meta);
  assert.equal(meta.mime, 'image/bmp');
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 128);
});

test('sniffImage: BMP top-down (negative height) reports absolute value', () => {
  const meta = sniffImage(bmpHeader(64, -64));
  assert.ok(meta);
  assert.equal(meta.width, 64);
  assert.equal(meta.height, 64);
});

test('sniffImage: JPEG SOF0 → height@5 width@7', () => {
  // SOI, then a SOF0 (0xFFC0) segment: len=0x0011, precision=8, h=200, w=300.
  const buf = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // segment length (17)
    0x08, // sample precision
    0x00, 0xc8, // height = 200
    0x01, 0x2c, // width = 300
    0x03, // component count
    0x01, 0x22, 0x00, // comp 1
    0x02, 0x11, 0x01, // comp 2
    0x03, 0x11, 0x01, // comp 3
  ]);
  const meta = sniffImage(buf);
  assert.ok(meta);
  assert.equal(meta.mime, 'image/jpeg');
  assert.equal(meta.height, 200);
  assert.equal(meta.width, 300);
});

test('sniffImage: JPEG skips APP0 then reads SOF2 dimensions', () => {
  const buf = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, // APP0
    0x00, 0x06, // length 6
    0x4a, 0x46, 0x49, 0x46, // "JFIF"
    0xff, 0xc2, // SOF2 (progressive)
    0x00, 0x11, // length
    0x08, // precision
    0x00, 0x40, // height = 64
    0x00, 0x80, // width = 128
    0x03,
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ]);
  const meta = sniffImage(buf);
  assert.ok(meta);
  assert.equal(meta.height, 64);
  assert.equal(meta.width, 128);
});

test('sniffImage: WEBP VP8X extended canvas dimensions', () => {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(22, 4); // riff size (not validated)
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8X', 12, 'latin1');
  buf.writeUInt32LE(10, 16); // chunk size
  buf[20] = 0x00; // flags
  // reserved 21..23 = 0; width-1 (24-bit LE) at payload+4 = offset 24.
  const w = 1024;
  const h = 768;
  buf[24] = (w - 1) & 0xff;
  buf[25] = ((w - 1) >> 8) & 0xff;
  buf[26] = ((w - 1) >> 16) & 0xff;
  buf[27] = (h - 1) & 0xff;
  buf[28] = ((h - 1) >> 8) & 0xff;
  buf[29] = ((h - 1) >> 16) & 0xff;
  const meta = sniffImage(buf);
  assert.ok(meta);
  assert.equal(meta.mime, 'image/webp');
  assert.equal(meta.width, 1024);
  assert.equal(meta.height, 768);
});

test('sniffImage: WEBP VP8L packed dimensions', () => {
  const buf = Buffer.alloc(25);
  buf.write('RIFF', 0, 'latin1');
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8L', 12, 'latin1');
  buf.writeUInt32LE(10, 16);
  buf[20] = 0x2f; // VP8L signature byte
  // (width-1) in low 14 bits, (height-1) in next 14 bits.
  const w = 100;
  const h = 50;
  const packed = (w - 1) | ((h - 1) << 14);
  buf.writeUInt32LE(packed >>> 0, 21);
  const meta = sniffImage(buf);
  assert.ok(meta);
  assert.equal(meta.mime, 'image/webp');
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 50);
});

test('sniffImage: junk buffer → null', () => {
  assert.equal(sniffImage(Buffer.from('not an image at all, just text bytes')), null);
});

test('sniffImage: too-short buffer → null', () => {
  assert.equal(sniffImage(Buffer.from([0x89])), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test('sniffImage: recognized signature but truncated dims still yields mime', () => {
  // PNG signature only (8 bytes) — no IHDR data to read.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const meta = sniffImage(sig);
  assert.ok(meta);
  assert.equal(meta.mime, 'image/png');
  assert.equal(meta.width, undefined);
  assert.equal(meta.height, undefined);
});
