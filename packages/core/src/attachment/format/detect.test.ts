import test from 'node:test';
import assert from 'node:assert/strict';
import { detectKind } from './detect.js';

/** Minimal PNG header (signature + IHDR with dimensions) for magic-byte tests. */
function pngHeader(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([sig, ihdr]);
}

test('detectKind: .pdf extension → pdf', () => {
  assert.deepEqual(detectKind({ name: 'report.pdf' }), {
    kind: 'pdf',
    mime: 'application/pdf',
  });
});

test('detectKind: .png buffer → image with png mime (magic bytes)', () => {
  const d = detectKind({ name: 'shot.png', buffer: pngHeader(10, 20) });
  assert.equal(d.kind, 'image');
  assert.equal(d.mime, 'image/png');
});

test('detectKind: .ts → code', () => {
  const d = detectKind({ name: 'index.ts' });
  assert.equal(d.kind, 'code');
  assert.equal(d.mime, 'text/x-typescript');
});

test('detectKind: .md → text', () => {
  const d = detectKind({ name: 'README.md' });
  assert.equal(d.kind, 'text');
  assert.equal(d.mime, 'text/markdown');
});

test('detectKind: unknown .xyz → file / octet-stream', () => {
  assert.deepEqual(detectKind({ name: 'mystery.xyz' }), {
    kind: 'file',
    mime: 'application/octet-stream',
  });
});

test('detectKind: magic bytes win over a misleading extension', () => {
  // Named .txt but the bytes are a PNG → classified as an image.
  const d = detectKind({ name: 'foo.txt', buffer: pngHeader(4, 4) });
  assert.equal(d.kind, 'image');
  assert.equal(d.mime, 'image/png');
});

test('detectKind: %PDF magic bytes → pdf even with a wrong name', () => {
  const buf = Buffer.from('%PDF-1.7\n...rest...', 'latin1');
  const d = detectKind({ name: 'notes.txt', buffer: buf });
  assert.equal(d.kind, 'pdf');
  assert.equal(d.mime, 'application/pdf');
});

test('detectKind: explicit specific MIME is honored', () => {
  const d = detectKind({ name: 'blob', mime: 'image/gif' });
  assert.equal(d.kind, 'image');
  assert.equal(d.mime, 'image/gif');
});

test('detectKind: generic octet-stream MIME is ignored in favor of extension', () => {
  const d = detectKind({ name: 'main.py', mime: 'application/octet-stream' });
  assert.equal(d.kind, 'code');
  assert.equal(d.mime, 'text/x-python');
});

test('detectKind: unknown extension keeps a provided specific MIME', () => {
  const d = detectKind({ name: 'data.bin', mime: 'application/vnd.custom' });
  assert.equal(d.kind, 'file');
  assert.equal(d.mime, 'application/vnd.custom');
});

test('detectKind: image extension without buffer still maps to image', () => {
  const d = detectKind({ name: 'photo.JPEG' });
  assert.equal(d.kind, 'image');
  assert.equal(d.mime, 'image/jpeg');
});

test('detectKind: .json → code', () => {
  const d = detectKind({ name: 'tsconfig.json' });
  assert.equal(d.kind, 'code');
  assert.equal(d.mime, 'application/json');
});

test('detectKind: empty name and no buffer → file', () => {
  assert.deepEqual(detectKind({ name: '' }), {
    kind: 'file',
    mime: 'application/octet-stream',
  });
});

test('detectKind: dotfile with no real extension → file', () => {
  // Leading-dot names (e.g. ".gitignore") have no extension segment.
  assert.deepEqual(detectKind({ name: '.gitignore' }), {
    kind: 'file',
    mime: 'application/octet-stream',
  });
});
