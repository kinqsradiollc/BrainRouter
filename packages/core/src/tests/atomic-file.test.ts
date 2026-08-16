import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../util/fs/atomicFile.js';

test('writeFileAtomic tolerates unsupported Windows directory fsync without weakening file fsync', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-atomic-win32-'));
  const target = path.join(directory, 'target.json');
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalFsync = fs.fsyncSync;
  let fsyncCalls = 0;
  try {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    fs.fsyncSync = (descriptor) => {
      fsyncCalls += 1;
      if (fsyncCalls === 2) {
        throw Object.assign(new Error('directory fsync is unsupported on Windows'), { code: 'EPERM' });
      }
      originalFsync(descriptor);
    };

    writeFileAtomic(target, '{"ok":true}\n');

    assert.equal(fsyncCalls, 2, 'the file is fsynced before the unsupported directory fsync');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"ok":true}\n');
  } finally {
    fs.fsyncSync = originalFsync;
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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
