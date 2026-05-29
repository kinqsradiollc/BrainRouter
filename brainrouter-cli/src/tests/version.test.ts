import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';

test('version: VERSION is read live from package.json (single source, not hardcoded)', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
  // From dist/tests/version.test.js, ../../package.json === package root.
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  // Guards against the 0.3.8-rot that the centralization fixed: the CLI
  // banner + MCP clientInfo must always equal the package's own version.
  assert.equal(VERSION, pkg.version);
});
