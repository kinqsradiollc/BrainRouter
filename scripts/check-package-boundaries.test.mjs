/**
 * Purpose: Prove both the accepted package graph and representative forbidden
 * edges used by the ADR-025 package-boundary gate.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  checkImport,
  checkManifest,
  checkRepositoryBoundaries,
  collectModuleSpecifiers,
  loadBoundaryPolicy,
} from './check-package-boundaries.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = loadBoundaryPolicy(repoRoot);

function fixture(area, relativePath, specifier) {
  return checkImport({
    area,
    filePath: path.join(repoRoot, relativePath),
    policy,
    specifier,
  });
}

test('current repository follows the declared dependency direction', () => {
  assert.deepEqual(checkRepositoryBoundaries(repoRoot), []);
});

test('parser recognizes imports, re-exports, dynamic imports, and require calls', () => {
  assert.deepEqual(
    collectModuleSpecifiers(`
      import value from "one";
      export { value } from "two";
      const dynamic = import("three");
      const required = require("four");
    `),
    ['one', 'two', 'three', 'four'],
  );
});

test('leaf packages cannot depend on Core', () => {
  assert.match(
    fixture('types', 'packages/types/src/fixture.ts', '@kinqs/brainrouter-core/review').reason,
    /may not depend on core/,
  );
  assert.match(
    fixture('protocol', 'packages/agent-protocol/src/fixture.ts', '@kinqs/brainrouter-types').reason,
    /may not depend on types/,
  );
});

test('leaf and hooks manifest contracts reject dependency drift', () => {
  assert.match(
    checkManifest('types', {
      name: '@kinqs/brainrouter-types',
      dependencies: { zod: '^4.0.0' },
    })[0].reason,
    /dependency-free/,
  );
  assert.match(
    checkManifest('hooks', {
      name: '@kinqs/brainrouter-hooks',
      dependencies: {
        '@kinqs/brainrouter-sdk': '^0.4.16',
        '@kinqs/brainrouter-types': '^0.4.16',
      },
    })[0].reason,
    /react must remain a peer dependency/,
  );
});

test('packages cannot reach into application source', () => {
  assert.match(
    fixture('types', 'packages/types/src/fixture.ts', '../../../brainrouter/src/index.js').reason,
    /may not import application source/,
  );
});

test('Dashboard cannot import Core or protocol', () => {
  assert.match(
    fixture('dashboard', 'brainrouter-dashboard/app/fixture.ts', '@kinqs/brainrouter-core/review').reason,
    /may not depend on core/,
  );
  assert.match(
    fixture('dashboard', 'brainrouter-dashboard/app/fixture.ts', '@kinqs/brainrouter-agent-protocol').reason,
    /may not depend on protocol/,
  );
});

test('SDK and hooks are browser-safe outside tests', () => {
  assert.match(fixture('sdk', 'packages/sdk/src/client.ts', 'node:fs').reason, /browser-safe/);
  assert.equal(fixture('sdk', 'packages/sdk/src/client.test.ts', 'node:test'), undefined);
  assert.match(fixture('hooks', 'packages/hooks/src/useFixture.ts', 'node:events').reason, /browser-safe/);
  assert.equal(fixture('hooks', 'packages/hooks/src/useFixture.test.ts', 'node:test'), undefined);
});

test('Core imports require curated public subpaths in every maintained consumer', () => {
  assert.match(
    fixture('cli', 'brainrouter-cli/src/fixture.ts', '@kinqs/brainrouter-core/private/path').reason,
    /not a curated public export/,
  );
  assert.match(
    fixture(
      'desktop-host',
      'brainrouter-desktop/electron/fixture.ts',
      '@kinqs/brainrouter-core/dist/workspace/profiles.js',
    ).reason,
    /not a supported public entrypoint/,
  );
  assert.match(
    fixture(
      'desktop-renderer',
      'brainrouter-desktop/src/fixture.ts',
      '@kinqs/brainrouter-core/dist/workspace/profiles.js',
    ).reason,
    /not a supported public entrypoint/,
  );
  assert.equal(
    fixture(
      'desktop-renderer',
      'brainrouter-desktop/src/fixture.ts',
      '@kinqs/brainrouter-core/workspace/profiles',
    ),
    undefined,
  );
  assert.equal(fixture('backend', 'brainrouter/src/fixture.ts', '@kinqs/brainrouter-core/review'), undefined);
});

test('maintained consumers cannot build a second routing owner behind the compatibility façade', () => {
  assert.match(
    fixture('backend', 'brainrouter/src/fixture.ts', '@kinqs/brainrouter-core/router').reason,
    /provider surface/,
  );
  assert.match(
    fixture('core', 'packages/core/src/agent/fixture.ts', '../router/index.js').reason,
    /provider\/routing/,
  );
  assert.equal(
    fixture('core', 'packages/core/src/router/compatibility.test.ts', './index.js'),
    undefined,
  );
});
