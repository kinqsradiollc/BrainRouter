import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectVisualReleaseBuild } from './verify-visual-release.mjs';

const lazyPrefixes = [
  'AtlasPanel-',
  'BrowserPanel-',
  'CIPanel-',
  'EditorPanel-',
  'WorkflowsPanel-',
];

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-visual-gate-'));
  fs.writeFileSync(path.join(directory, 'index-test.js'), 'export const ready = true;\n');
  fs.writeFileSync(path.join(directory, 'index-test.css'), ':root { color: CanvasText; }\n');
  for (const prefix of lazyPrefixes) {
    fs.writeFileSync(path.join(directory, `${prefix}test.js`), 'export {};\n');
  }
  return directory;
}

test('visual release gate accepts split assets within the budgets', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const report = inspectVisualReleaseBuild(directory);

  assert.equal(report.lazyChunks.length, lazyPrefixes.length);
  assert.equal(report.mainScript.name, 'index-test.js');
});

test('visual release gate rejects an oversized initial script', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'index-test.js'), Buffer.alloc(1_750_001, 1));

  assert.throws(
    () => inspectVisualReleaseBuild(directory),
    /Initial JavaScript is 1750001 bytes; release budget is 1750000 bytes/,
  );
});
