import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../util/fs/atomicFile.js';

test('writeFileAtomic rejects a staged path replaced before commit', { skip: process.platform === 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-atomic-'));
  const target = path.join(directory, 'target.json');
  const external = path.join(directory, 'external.json');
  let temporary = '';
  try {
    fs.writeFileSync(external, 'external\n');
    assert.throws(
      () => writeFileAtomic(target, 'candidate\n', {
        onStaged: (staged) => { temporary = staged.temporaryPath; },
        beforeCommit: () => {
          fs.renameSync(temporary, `${temporary}.displaced`);
          fs.symlinkSync(external, temporary);
        },
      }),
      /Staged file changed before commit/,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(external, 'utf8'), 'external\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
