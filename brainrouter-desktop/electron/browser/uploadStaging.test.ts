import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  UploadStagingError,
  stageWorkspaceUploadFiles,
} from './uploadStaging.js';

function fixture(): { parent: string; workspace: string; temp: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-stage-test-'));
  const workspace = path.join(parent, 'workspace');
  const temp = path.join(parent, 'temp');
  fs.mkdirSync(workspace);
  fs.mkdirSync(temp);
  return { parent, workspace, temp };
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}

test('stages async copies in unique private subdirectories while preserving basenames', async () => {
  const { parent, workspace, temp } = fixture();
  fs.mkdirSync(path.join(workspace, 'one'));
  fs.mkdirSync(path.join(workspace, 'two'));
  fs.writeFileSync(path.join(workspace, 'one', 'report.txt'), 'first');
  fs.writeFileSync(path.join(workspace, 'two', 'report.txt'), 'second');
  try {
    const staged = await stageWorkspaceUploadFiles({ workspaceRoot: workspace, tempRoot: temp, files: ['one/report.txt', 'two/report.txt'] });
    assert.equal(staged.files.length, 2);
    assert.equal(path.basename(staged.files[0]), 'report.txt');
    assert.equal(path.basename(staged.files[1]), 'report.txt');
    assert.notEqual(path.dirname(staged.files[0]), path.dirname(staged.files[1]));
    assert.deepEqual(staged.files.map((file) => fs.readFileSync(file, 'utf8')), ['first', 'second']);
    assert.equal(JSON.stringify(staged).includes(workspace), false, 'result never contains a source path');
    assert.equal(fs.statSync(staged.directory).mode & 0o777, 0o700);
    for (const file of staged.files) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const directory = staged.directory;
    staged.cleanup();
    staged.cleanup();
    assert.equal(fs.existsSync(directory), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('rejects absolute, URI, traversal, control, empty, and over-bounded source lists without leaking paths', async () => {
  const { parent, workspace, temp } = fixture();
  fs.writeFileSync(path.join(workspace, 'safe.txt'), 'safe');
  const invalid: unknown[] = [
    '/private/secret.txt',
    'C:\\private\\secret.txt',
    '\\\\server\\share\\secret.txt',
    'file:///private/secret.txt',
    'https://example.com/secret.txt',
    '../secret.txt',
    'safe/../../secret.txt',
    'bad\u0000name.txt',
    '',
  ];
  try {
    for (const source of invalid) {
      await assert.rejects(
        stageWorkspaceUploadFiles({ workspaceRoot: workspace, tempRoot: temp, files: [source] }),
        (error: unknown) => {
          assert.ok(error instanceof UploadStagingError);
          assert.equal(errorText(error).includes(workspace), false);
          // Skip the leak check for the empty source: `includes('')` is vacuously
          // true and an empty string carries no path to leak in the first place.
          if (String(source).length > 0) assert.equal(errorText(error).includes(String(source)), false);
          return true;
        },
      );
    }
    await assert.rejects(stageWorkspaceUploadFiles({ workspaceRoot: workspace, tempRoot: temp, files: [] }), /between 1 and 20/i);
    await assert.rejects(stageWorkspaceUploadFiles({ workspaceRoot: workspace, tempRoot: temp, files: Array.from({ length: 21 }, () => 'safe.txt') }), /between 1 and 20/i);
    assert.deepEqual(fs.readdirSync(temp), []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('rejects every symlink ancestor and final file without staging outside content', { skip: process.platform === 'win32' }, async () => {
  for (const linkKind of ['ancestor', 'final'] as const) {
    const { parent, workspace, temp } = fixture();
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret');
    if (linkKind === 'ancestor') fs.symlinkSync(outside, path.join(workspace, 'linked'), 'dir');
    else fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'linked.txt'));
    try {
      const source = linkKind === 'ancestor' ? 'linked/secret.txt' : 'linked.txt';
      await assert.rejects(
        stageWorkspaceUploadFiles({ workspaceRoot: workspace, tempRoot: temp, files: [source] }),
        (error: unknown) => error instanceof UploadStagingError && error.code === 'DENIED',
      );
      assert.deepEqual(fs.readdirSync(temp), []);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  }
});

test('directory watches detect an ancestor rename-and-restore during asynchronous copying', { skip: process.platform === 'win32' }, async () => {
  const { parent, workspace, temp } = fixture();
  const sourceDirectory = path.join(workspace, 'files');
  const movedDirectory = path.join(workspace, 'files-moved');
  fs.mkdirSync(sourceDirectory);
  fs.writeFileSync(path.join(sourceDirectory, 'payload.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
  let raced = false;
  try {
    await assert.rejects(stageWorkspaceUploadFiles({
      workspaceRoot: workspace,
      tempRoot: temp,
      files: ['files/payload.bin'],
      testHooks: {
        afterCopyChunk: async () => {
          if (raced) return;
          raced = true;
          fs.renameSync(sourceDirectory, movedDirectory);
          fs.renameSync(movedDirectory, sourceDirectory);
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
      },
    }), (error: unknown) => error instanceof UploadStagingError && error.code === 'DENIED');
    assert.equal(raced, true);
    assert.deepEqual(fs.readdirSync(temp), [], 'failed staging is cleaned');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('detects source replacement and content mutation during copying', async () => {
  for (const mutation of ['replace', 'content'] as const) {
    const { parent, workspace, temp } = fixture();
    const source = path.join(workspace, 'payload.bin');
    const moved = path.join(workspace, 'payload-old.bin');
    fs.writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 3));
    let raced = false;
    try {
      await assert.rejects(stageWorkspaceUploadFiles({
        workspaceRoot: workspace,
        tempRoot: temp,
        files: ['payload.bin'],
        testHooks: {
          afterCopyChunk: async () => {
            if (raced) return;
            raced = true;
            if (mutation === 'replace') {
              fs.renameSync(source, moved);
              fs.writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 3));
            } else {
              fs.writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 9));
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
          },
        },
      }), (error: unknown) => error instanceof UploadStagingError && error.code === 'DENIED');
      assert.equal(raced, true);
      assert.deepEqual(fs.readdirSync(temp), []);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  }
});

test('enforces 512 MiB per-file and 1 GiB aggregate limits before copying sparse sources', async () => {
  const { parent, workspace, temp } = fixture();
  const tooLarge = path.join(workspace, 'too-large.bin');
  fs.writeFileSync(tooLarge, '');
  fs.truncateSync(tooLarge, MAX_UPLOAD_FILE_BYTES + 1);
  try {
    await assert.rejects(
      stageWorkspaceUploadFiles({ workspaceRoot: workspace, tempRoot: temp, files: ['too-large.bin'] }),
      (error: unknown) => error instanceof UploadStagingError && error.code === 'TOO_LARGE',
    );
    fs.unlinkSync(tooLarge);
    for (const [name, size] of [['a.bin', MAX_UPLOAD_FILE_BYTES], ['b.bin', MAX_UPLOAD_FILE_BYTES], ['c.bin', 1]] as const) {
      const file = path.join(workspace, name);
      fs.writeFileSync(file, '');
      fs.truncateSync(file, size);
    }
    await assert.rejects(
      stageWorkspaceUploadFiles({ workspaceRoot: workspace, tempRoot: temp, files: ['a.bin', 'b.bin', 'c.bin'] }),
      (error: unknown) => error instanceof UploadStagingError && error.code === 'TOO_LARGE' && MAX_UPLOAD_TOTAL_BYTES === 1024 * 1024 * 1024,
    );
    assert.deepEqual(fs.readdirSync(temp), []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
