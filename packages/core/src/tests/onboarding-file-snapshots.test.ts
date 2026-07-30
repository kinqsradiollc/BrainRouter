/**
 * Workspace-onboarding file snapshot adapter fixtures.
 *
 * A25-5b: proves no-follow reads, bounded sizes, exact identity and content
 * matching, encoded-content integrity, and concurrent replacement detection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeSnapshotContents,
  encodeSnapshot,
  encodeVersion,
  snapshotMatchesVersion,
  snapshotRegularFile,
  snapshotsAreExact,
  validEncodedSnapshot,
} from '../workspace/onboardingTransaction/fileSnapshots.js';

function withFixture(
  run: (directory: string, target: string) => void,
): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboarding-snapshot-'));
  const target = path.join(directory, 'AGENT.md');
  try {
    run(directory, target);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('snapshot reads reject symbolic links and oversized files', () => {
  withFixture((directory, target) => {
    fs.writeFileSync(target, 'safe');
    const link = path.join(directory, 'linked.md');
    fs.symlinkSync(target, link);

    assert.throws(
      () => snapshotRegularFile(link, 64, 'project instruction file'),
      /Unsafe project instruction file/,
    );
    assert.throws(
      () => snapshotRegularFile(target, 3, 'project instruction file'),
      /Unsafe project instruction file/,
    );
  });
});

test('exact and version matches include inode, timestamps, size, and content hash', () => {
  withFixture((_directory, target) => {
    fs.writeFileSync(target, 'first', { mode: 0o640 });
    const first = snapshotRegularFile(target, 64, 'project instruction file');
    const encoded = encodeVersion(first);
    const copy = {
      ...first,
      contents: Buffer.from(first.contents!),
    };

    assert.equal(snapshotsAreExact(first, copy), true);
    assert.equal(snapshotMatchesVersion(copy, encoded, true), true);
    assert.equal(snapshotsAreExact(first, { ...copy, ino: copy.ino! + 1 }), false);
    assert.equal(snapshotsAreExact(first, { ...copy, mtimeMs: copy.mtimeMs! + 1 }), false);
    assert.equal(snapshotMatchesVersion(
      { ...copy, contents: Buffer.from('other') },
      encoded,
      true,
    ), false);
  });
});

test('encoded snapshots reject tampered contents and preserve valid bytes', () => {
  withFixture((_directory, target) => {
    fs.writeFileSync(target, 'encoded');
    const snapshot = snapshotRegularFile(target, 64, 'project instruction file');
    const encoded = encodeSnapshot(snapshot);

    assert.equal(validEncodedSnapshot(encoded, 64), true);
    assert.deepEqual(decodeSnapshotContents(encoded, 64), Buffer.from('encoded'));
    assert.equal(validEncodedSnapshot({
      ...encoded,
      contentsBase64: Buffer.from('tampered').toString('base64'),
    }, 64), false);
    assert.throws(
      () => decodeSnapshotContents({
        ...encoded,
        contentsBase64: Buffer.from('tampered').toString('base64'),
      }, 64),
      /contents are invalid/,
    );
  });
});

test('snapshot reads reject a concurrent path replacement', (context) => {
  withFixture((directory, target) => {
    fs.writeFileSync(target, Buffer.alloc(8 * 1024, 1));
    const displaced = path.join(directory, 'displaced.md');
    const originalRead = fs.readSync;
    let replaced = false;
    context.mock.method(fs, 'readSync', ((...args: Parameters<typeof fs.readSync>) => {
      const read = originalRead(...args);
      if (!replaced) {
        replaced = true;
        fs.renameSync(target, displaced);
        fs.writeFileSync(target, Buffer.alloc(8 * 1024, 1));
      }
      return read;
    }) as typeof fs.readSync);

    assert.throws(
      () => snapshotRegularFile(target, 16 * 1024, 'project instruction file'),
      /changed while reading/,
    );
  });
});
