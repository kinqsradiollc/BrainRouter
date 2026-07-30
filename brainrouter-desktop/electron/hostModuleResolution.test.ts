import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { installUnpackedModuleResolution } from './hostModuleResolution.js';

test('redirects a packed CommonJS entry to unpacked node_modules', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-unpacked-modules-'));
  const root = path.join(tempRoot, 'Resources', 'app.asar.unpacked', 'node_modules');
  const packageRoot = path.join(root, 'fixture-package');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'fixture-package',
    main: 'index.cjs',
  }));
  fs.writeFileSync(path.join(packageRoot, 'index.cjs'), 'module.exports = { source: "unpacked" };');

  const restore = installUnpackedModuleResolution(root);
  try {
    const require = createRequire(import.meta.url);
    const packedEntry = path.join(
      tempRoot,
      'Resources',
      'app.asar',
      'node_modules',
      'fixture-package',
      'index.cjs',
    );
    assert.deepEqual(require(packedEntry), { source: 'unpacked' });
  } finally {
    restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('rejects a relative unpacked node_modules root', () => {
  assert.throws(
    () => installUnpackedModuleResolution('node_modules'),
    /must be absolute/,
  );
});
