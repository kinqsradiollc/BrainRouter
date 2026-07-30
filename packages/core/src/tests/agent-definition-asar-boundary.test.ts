import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { containedAsarArchive } from '../fs/boundedFileIdentity.js';

test('recognizes a definition contained by matching directories in one archive', () => {
  const archive = path.resolve('/Applications/BrainRouter.app/Contents/Resources/app.asar');
  const agents = path.join(archive, 'node_modules', '@kinqs', 'brainrouter-core', 'agents');
  const file = path.join(agents, 'worker.json');
  assert.equal(
    containedAsarArchive(file, agents, agents),
    archive,
  );
});

test('rejects archive entries outside either declared boundary', () => {
  const archive = path.resolve('/Applications/BrainRouter.app/Contents/Resources/app.asar');
  const packageRoot = path.join(archive, 'node_modules', '@kinqs', 'brainrouter-core');
  const agents = path.join(packageRoot, 'agents');
  const file = path.join(packageRoot, 'personas', 'engineering.json');
  assert.equal(containedAsarArchive(file, agents, packageRoot), null);
});

test('does not weaken the normal filesystem boundary path', () => {
  const agents = path.resolve('/tmp/brainrouter/agents');
  assert.equal(containedAsarArchive(path.join(agents, 'worker.json'), agents, agents), null);
});
