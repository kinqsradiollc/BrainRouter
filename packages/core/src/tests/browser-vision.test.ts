/**
 * ADR-055 P1 — the browser-screenshot vision handoff: reads only in-tree PNG/JPG
 * artifacts, fails closed on everything else, and never throws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserScreenshotImageHandoff, BROWSER_SCREENSHOT_DIR } from '../agent/browser/browserVision.js';

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-vision-'));
  fs.mkdirSync(path.join(root, BROWSER_SCREENSHOT_DIR), { recursive: true });
  return root;
}
function writeShot(root: string, name: string, bytes: Buffer): string {
  const rel = `${BROWSER_SCREENSHOT_DIR}${name}`;
  fs.writeFileSync(path.join(root, rel), bytes);
  return rel;
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('reads an in-tree PNG named by the result and returns base64 + media type', () => {
  const root = workspace();
  const rel = writeShot(root, 'shot.png', PNG);
  const img = browserScreenshotImageHandoff('browser_screenshot', JSON.stringify({ data: { path: rel } }), root);
  assert.ok(img, 'expected an image');
  assert.equal(img!.mediaType, 'image/png');
  assert.equal(img!.dataBase64, PNG.toString('base64'));
});

test('tolerates a bare {path} result shape', () => {
  const root = workspace();
  const rel = writeShot(root, 'bare.png', PNG);
  const img = browserScreenshotImageHandoff('browser_screenshot', JSON.stringify({ path: rel }), root);
  assert.equal(img?.mediaType, 'image/png');
});

test('only browser_screenshot is handled', () => {
  const root = workspace();
  const rel = writeShot(root, 'x.png', PNG);
  assert.equal(browserScreenshotImageHandoff('read_file', JSON.stringify({ path: rel }), root), null);
});

test('rejects a path outside the screenshots dir', () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'secret.png'), PNG);
  assert.equal(browserScreenshotImageHandoff('browser_screenshot', JSON.stringify({ path: 'secret.png' }), root), null);
});

test('rejects traversal and absolute paths', () => {
  const root = workspace();
  assert.equal(browserScreenshotImageHandoff('browser_screenshot', JSON.stringify({ path: `${BROWSER_SCREENSHOT_DIR}../../etc/passwd` }), root), null);
  assert.equal(browserScreenshotImageHandoff('browser_screenshot', JSON.stringify({ path: '/etc/passwd' }), root), null);
});

test('rejects a non-image extension even in the screenshots dir', () => {
  const root = workspace();
  const rel = writeShot(root, 'note.txt', Buffer.from('hi'));
  assert.equal(browserScreenshotImageHandoff('browser_screenshot', JSON.stringify({ path: rel }), root), null);
});

test('never throws on malformed input', () => {
  const root = workspace();
  assert.equal(browserScreenshotImageHandoff('browser_screenshot', 'not json', root), null);
  assert.equal(browserScreenshotImageHandoff('browser_screenshot', JSON.stringify({}), root), null);
  assert.equal(browserScreenshotImageHandoff('browser_screenshot', JSON.stringify({ path: `${BROWSER_SCREENSHOT_DIR}missing.png` }), root), null);
});

test('cli.browser.vision defaults to auto; off is respected', async () => {
  const { resolveCliKnobs } = await import('../config/config.js');
  assert.equal(resolveCliKnobs({ cli: {} } as never).browser.vision, 'auto');
  assert.equal(resolveCliKnobs({ cli: { browser: { vision: 'off' } } } as never).browser.vision, 'off');
  assert.equal(resolveCliKnobs({ cli: { browser: { vision: 'auto' } } } as never).browser.vision, 'auto');
});
