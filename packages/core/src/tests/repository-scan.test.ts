/**
 * Bounded repository summaries stay deterministic, read-only,
 * secret-free, and safe around binary, unreadable, and symlinked entries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_REPOSITORY_SCAN_LIMITS,
  REPOSITORY_SCAN_ROOT_MARKERS,
  scanRepository,
  type RepositoryScanOptions,
  type RepositoryScanSummary,
} from '../workspace/repositoryScan.js';
import { suggestWorkspaceProfileFromScan } from '../workspace/profileSuggest.js';

type PublicLifecycleHooksAreAbsent =
  'beforeDirectoryOpen' extends keyof RepositoryScanOptions ? false :
    'beforeFileOpen' extends keyof RepositoryScanOptions ? false : true;
const PUBLIC_LIFECYCLE_HOOKS_ARE_ABSENT: PublicLifecycleHooksAreAbsent = true;

function tempRepository(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-repository-scan-')));
}

function scan(root: string, options: RepositoryScanOptions = {}): RepositoryScanSummary {
  return scanRepository(root, { now: () => 0, ...options });
}

function write(root: string, relativePath: string, contents: string | Buffer): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

test('repository scan returns deterministic sorted paths and fixed root markers without writing', () => {
  const root = tempRepository();
  try {
    write(root, 'z-last.txt', 'z');
    write(root, 'src/z.ts', 'export const z = true;\n');
    write(root, 'README.md', '# Demo\n');
    write(root, 'package.json', '{"name":"demo"}\n');
    write(root, 'src/a.ts', 'export const a = true;\n');
    const before = fs.readdirSync(root, { recursive: true }).map(String).sort();

    const first = scan(root);
    const second = scan(root);

    assert.deepEqual(first, second, 'the same tree and clock produce a byte-stable summary');
    assert.deepEqual(first.markers, ['README.md', 'package.json']);
    assert.deepEqual(first.directories, ['src']);
    assert.deepEqual(first.files.map((file) => file.path), [
      'README.md',
      'package.json',
      'src/a.ts',
      'src/z.ts',
      'z-last.txt',
    ]);
    assert.deepEqual(
      fs.readdirSync(root, { recursive: true }).map(String).sort(),
      before,
      'scanning creates or removes no repository entry',
    );
    assert.ok(REPOSITORY_SCAN_ROOT_MARKERS.includes('AGENT.md'));
    assert.ok(REPOSITORY_SCAN_ROOT_MARKERS.includes('DESIGN.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan enforces the entry limit across ignored entries', () => {
  const root = tempRepository();
  try {
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) write(root, name, name);

    const result = scan(root, { limits: { maxEntries: 2 } });

    assert.equal(result.stats.entriesVisited, 2);
    assert.ok(result.files.length <= 2);
    assert.ok(result.stoppedBy.includes('entry-limit'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan checks entry bounds while iterating instead of materializing a directory', () => {
  const root = tempRepository();
  const originalOpendir = fs.opendirSync;
  const originalReaddir = fs.readdirSync;
  let readCalls = 0;
  try {
    for (let index = 0; index < 20; index += 1) write(root, `file-${index}.txt`, String(index));
    fs.readdirSync = (() => {
      throw new Error('repository scans must not materialize whole directories');
    }) as typeof fs.readdirSync;
    fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => {
      const directory = originalOpendir(...args);
      const originalRead = directory.readSync.bind(directory);
      directory.readSync = (() => {
        readCalls += 1;
        if (readCalls > 3) throw new Error('entry iteration exceeded the configured bound');
        return originalRead();
      }) as typeof directory.readSync;
      return directory;
    }) as typeof fs.opendirSync;

    const result = scan(root, { limits: { maxEntries: 3 } });

    assert.equal(readCalls, 3, 'the iterator stops without reading a fourth directory entry');
    assert.equal(result.stats.entriesVisited, 3);
    assert.ok(result.stoppedBy.includes('entry-limit'));
  } finally {
    fs.opendirSync = originalOpendir;
    fs.readdirSync = originalReaddir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan prioritizes root markers and enforces the file limit', () => {
  const root = tempRepository();
  try {
    write(root, 'a.txt', 'ordinary');
    write(root, 'README.md', 'high signal');
    write(root, 'z.txt', 'ordinary');

    const result = scan(root, { limits: { maxFiles: 1 } });

    assert.deepEqual(result.files.map((file) => file.path), ['README.md']);
    assert.equal(result.stats.filesRead, 1);
    assert.ok(result.stoppedBy.includes('file-limit'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan enforces aggregate and per-file byte limits independently', () => {
  const root = tempRepository();
  try {
    write(root, 'a.txt', 'abcdefgh');
    write(root, 'b.txt', 'ijklmnop');

    const perFile = scan(root, { limits: { maxFileBytes: 3, maxAggregateBytes: 20 } });
    assert.deepEqual(perFile.files.map((file) => file.content), ['abc', 'ijk']);
    assert.ok(perFile.files.every((file) => file.truncated));
    assert.equal(perFile.stats.bytesRead, 6);
    assert.ok(perFile.stoppedBy.includes('file-byte-limit'));
    assert.ok(!perFile.stoppedBy.includes('aggregate-byte-limit'));

    const aggregate = scan(root, { limits: { maxFileBytes: 20, maxAggregateBytes: 5 } });
    assert.deepEqual(aggregate.files.map((file) => file.content), ['abcde']);
    assert.equal(aggregate.stats.bytesRead, 5);
    assert.equal(aggregate.files[0]?.truncated, true);
    assert.ok(aggregate.stoppedBy.includes('aggregate-byte-limit'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan drops truncated URL userinfo at either byte boundary', () => {
  const safeLine = 'ordinary repository context\n';
  const credentialPrefix = 'endpoint=https://user:password123';
  const contents = `${safeLine}${credentialPrefix}@private.example/path\n`;
  const boundaryBytes = Buffer.byteLength(safeLine + credentialPrefix);
  const cases: Array<{ name: string; limits: RepositoryScanOptions['limits'] }> = [
    {
      name: 'per-file',
      limits: { maxFileBytes: boundaryBytes, maxAggregateBytes: boundaryBytes + 1024 },
    },
    {
      name: 'aggregate',
      limits: { maxFileBytes: boundaryBytes + 1024, maxAggregateBytes: boundaryBytes },
    },
  ];

  for (const entry of cases) {
    const root = tempRepository();
    try {
      write(root, 'notes.txt', contents);

      const result = scan(root, { limits: entry.limits });

      assert.deepEqual(result.files, [], `${entry.name} truncation fails closed for partial userinfo`);
      assert.equal(result.stats.ignoredEntries, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('repository scan charges a post-read validation failure against the aggregate budget', () => {
  const root = tempRepository();
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const fileTargets = new Map<number, string>();
  let actualBytesRead = 0;
  try {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) write(root, name, 'x'.repeat(32));
    fs.openSync = ((target, flags, mode) => {
      const descriptor = originalOpen(target, flags, mode);
      if (String(target).endsWith('.txt')) fileTargets.set(descriptor, String(target));
      return descriptor;
    }) as typeof fs.openSync;
    fs.readSync = ((descriptor, buffer, offset, length, position) => {
      const bytesRead = originalRead(descriptor, buffer, offset, length, position);
      actualBytesRead += bytesRead;
      const target = fileTargets.get(descriptor);
      if (target) fs.appendFileSync(target, 'changed-after-read');
      return bytesRead;
    }) as typeof fs.readSync;

    const result = scan(root, {
      limits: { maxFiles: 3, maxFileBytes: 32, maxAggregateBytes: 32 },
    });

    assert.equal(actualBytesRead, 32, 'the aggregate reservation stops a second failed read');
    assert.equal(result.stats.filesRead, 1);
    assert.equal(result.stats.bytesRead, 32);
    assert.equal(result.stats.unreadableEntries, 1);
    assert.deepEqual(result.files, []);
    assert.ok(result.stoppedBy.includes('aggregate-byte-limit'));
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan enforces nesting depth while retaining shallower files', () => {
  const root = tempRepository();
  try {
    write(root, 'root.txt', 'root');
    write(root, 'one/one.txt', 'one');
    write(root, 'one/two/two.txt', 'two');

    const result = scan(root, { limits: { maxDepth: 1 } });

    assert.deepEqual(result.files.map((file) => file.path), ['one/one.txt', 'root.txt']);
    assert.ok(result.stoppedBy.includes('depth-limit'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan preserves empty directory signals for deterministic profile suggestion', () => {
  const cases: Array<{ directory: string; profile: string }> = [
    { directory: 'notebooks', profile: 'data-science' },
    { directory: 'src', profile: 'engineering' },
    { directory: 'papers', profile: 'research' },
  ];
  for (const entry of cases) {
    const root = tempRepository();
    try {
      fs.mkdirSync(path.join(root, entry.directory));

      const result = scan(root);

      assert.deepEqual(result.directories, [entry.directory]);
      assert.equal(suggestWorkspaceProfileFromScan(result).profile, entry.profile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('repository scan stops at its deadline through an injected clock', () => {
  const root = tempRepository();
  const originalOpendir = fs.opendirSync;
  try {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) write(root, name, name);
    let tick = 0;
    let readCalls = 0;
    fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => {
      const directory = originalOpendir(...args);
      const originalRead = directory.readSync.bind(directory);
      directory.readSync = (() => {
        readCalls += 1;
        tick += 1;
        return originalRead();
      }) as typeof directory.readSync;
      return directory;
    }) as typeof fs.opendirSync;

    const result = scanRepository(root, {
      limits: { deadlineMs: 2 },
      now: () => tick,
    });

    assert.ok(result.stoppedBy.includes('deadline'));
    assert.equal(readCalls, 2, 'the deadline is checked between iterator reads');
    assert.ok(result.stats.entriesVisited < 3, 'deadline prevents a complete traversal');
  } finally {
    fs.opendirSync = originalOpendir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan ignores VCS, dependencies, build output, caches, runtime state, and secret files', () => {
  const root = tempRepository();
  try {
    const ignoredDirectories = [
      '.git',
      'node_modules',
      'dist',
      '.cache',
      '.brainrouter',
      '.config',
      '.docker',
      '.ssh',
      'secrets',
    ];
    for (const directory of ignoredDirectories) write(root, `${directory}/hidden.txt`, 'must not escape');
    for (const secret of [
      '.env',
      '.envrc',
      'server.env',
      'credentials.json',
      'secrets.txt',
      'id_rsa',
      'state.tfstate',
      'private.pem',
    ]) {
      write(root, secret, 'must not escape');
    }
    write(root, '.env.example', 'SAFE_PLACEHOLDER=value\n');
    write(root, 'server.env.example', 'SAFE_PLACEHOLDER=value\n');
    write(root, 'visible-secret.txt', 'OPENAI_API_KEY=sk-secretvalue123\n');
    write(root, 'visible.txt', 'visible');

    const result = scan(root);
    const paths = result.files.map((file) => file.path);

    assert.deepEqual(paths, ['.env.example', 'server.env.example', 'visible.txt']);
    assert.ok(result.files.every((file) => !file.content.includes('must not escape')));
    assert.equal(result.stats.ignoredEntries, ignoredDirectories.length + 9);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan drops files containing common credential shapes', () => {
  const root = tempRepository();
  try {
    const credentials = [
      'DATABASE_URL=postgres://user:password@database.example/app',
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'GOOGLE_API_KEY=AIzaSyD1234567890abcdefghijklmnop',
      'token=eyJhbGciOiJIUzI1NiJ9.payloadpayload.signaturepart',
      'endpoint=https://user:password@example.test/private',
      'Authorization: Bearer abcdefghijklmnop',
    ];
    credentials.forEach((credential, index) => {
      write(root, `credential-${index}.txt`, `${credential}\n`);
    });
    write(root, 'visible.txt', 'ordinary repository context\n');

    const result = scan(root);

    assert.deepEqual(result.files.map((file) => file.path), ['visible.txt']);
    assert.equal(result.stats.ignoredEntries, credentials.length);
    assert.ok(result.files.every((file) => !credentials.some((credential) =>
      file.content.includes(credential))));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan ignores extension-known and content-detected binary files', () => {
  const root = tempRepository();
  try {
    write(root, 'image.png', Buffer.from('not read despite text-like bytes'));
    write(root, 'opaque.dat', Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));
    write(root, 'invalid-utf8.txt', Buffer.from([0xc3, 0x28]));
    write(root, 'plain.txt', 'plain text');

    const result = scan(root);

    assert.deepEqual(result.files.map((file) => file.path), ['plain.txt']);
    assert.equal(result.stats.filesRead, 3, 'extension-known binaries do not consume the file-read budget');
    assert.equal(result.stats.bytesRead, 17, 'content classification remains inside the aggregate byte budget');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan never follows file or directory symlinks', () => {
  const root = tempRepository();
  const outside = tempRepository();
  try {
    write(root, 'visible.txt', 'visible');
    write(outside, 'outside.txt', 'outside secret');
    fs.symlinkSync(path.join(outside, 'outside.txt'), path.join(root, 'linked-file.txt'));
    fs.symlinkSync(outside, path.join(root, 'linked-directory'));

    const result = scan(root);

    assert.deepEqual(result.files.map((file) => file.path), ['visible.txt']);
    assert.ok(result.files.every((file) => !file.content.includes('outside secret')));
    assert.equal(result.stats.ignoredEntries, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('repository scan rejects a queued directory after an ancestor becomes an external symlink', {
  skip: process.platform === 'win32',
}, () => {
  const root = tempRepository();
  const outside = tempRepository();
  const parent = path.join(root, 'parent');
  const displaced = path.join(root, 'parent-displaced');
  const originalOpen = fs.openSync;
  let swapped = false;
  try {
    write(root, 'parent/child/inside.txt', 'inside repository');
    write(outside, 'child/inside.txt', 'outside secret');

    fs.openSync = ((target, flags, mode) => {
      if (!swapped && path.basename(String(target)) === 'child') {
        fs.renameSync(parent, displaced);
        fs.symlinkSync(outside, parent);
        swapped = true;
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.openSync;

    const result = scan(root);

    assert.equal(swapped, true, 'the test must swap the ancestor after its child is queued');
    assert.ok(result.files.every((file) => !file.content.includes('outside secret')));
    assert.ok(!result.files.some((file) => file.path === 'parent/child/inside.txt'));
    assert.ok(result.stats.unreadableEntries >= 1, 'the changed queued path fails closed');
  } finally {
    fs.openSync = originalOpen;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('repository scan rejects a file read after its parent becomes an external symlink', {
  skip: process.platform === 'win32',
}, () => {
  const root = tempRepository();
  const outside = tempRepository();
  const parent = path.join(root, 'parent');
  const displaced = path.join(root, 'parent-displaced');
  const originalOpen = fs.openSync;
  let swapped = false;
  try {
    write(root, 'parent/inside.txt', 'inside repository');
    write(outside, 'inside.txt', 'outside secret');

    fs.openSync = ((target, flags, mode) => {
      if (!swapped && path.basename(String(target)) === 'inside.txt') {
        fs.renameSync(parent, displaced);
        fs.symlinkSync(outside, parent);
        swapped = true;
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.openSync;

    const result = scan(root);

    assert.equal(swapped, true, 'the test must swap the parent between entry discovery and file open');
    assert.ok(result.files.every((file) => !file.content.includes('outside secret')));
    assert.ok(!result.files.some((file) => file.path === 'parent/inside.txt'));
    assert.ok(result.stats.unreadableEntries >= 1, 'the changed file parent fails closed');
  } finally {
    fs.openSync = originalOpen;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('repository scan keeps traversal lifecycle hooks out of its public options', () => {
  assert.equal(PUBLIC_LIFECYCLE_HOOKS_ARE_ABSENT, true);
});

test('repository scan anchors Linux directory and file opens to parent descriptors', {
  skip: process.platform !== 'linux',
}, () => {
  const root = tempRepository();
  const originalOpen = fs.openSync;
  const childOpenTargets = new Map<string, string>();
  try {
    write(root, 'parent/inside.txt', 'inside repository');
    fs.openSync = ((target, flags, mode) => {
      const targetText = String(target);
      const base = path.basename(targetText);
      if (base === 'parent' || base === 'inside.txt') childOpenTargets.set(base, targetText);
      return originalOpen(target, flags, mode);
    }) as typeof fs.openSync;

    const result = scan(root);

    assert.deepEqual(result.files.map((file) => file.path), ['parent/inside.txt']);
    assert.match(childOpenTargets.get('parent') ?? '', /^\/proc\/self\/fd\/\d+\/parent$/);
    assert.match(childOpenTargets.get('inside.txt') ?? '', /^\/proc\/self\/fd\/\d+\/inside\.txt$/);
  } finally {
    fs.openSync = originalOpen;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan degrades safely for a missing or non-directory root', () => {
  const root = tempRepository();
  const file = path.join(root, 'file.txt');
  write(root, 'file.txt', 'text');
  try {
    const missing = scan(path.join(root, 'missing'));
    const notDirectory = scan(file);

    assert.deepEqual(missing.files, []);
    assert.equal(missing.stats.unreadableEntries, 1);
    assert.deepEqual(notDirectory.files, []);
    assert.equal(notDirectory.stats.unreadableEntries, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scan defaults and invalid overrides remain explicitly bounded', () => {
  assert.deepEqual(DEFAULT_REPOSITORY_SCAN_LIMITS, {
    maxEntries: 2_000,
    maxFiles: 128,
    maxAggregateBytes: 512 * 1024,
    maxFileBytes: 64 * 1024,
    maxDepth: 8,
    deadlineMs: 900,
  });
  assert.throws(() => scanRepository('.', { limits: { maxFiles: -1 } }), /maxFiles/);
  assert.throws(() => scanRepository('.', { limits: { maxEntries: Number.POSITIVE_INFINITY } }), /maxEntries/);
  assert.throws(() => scanRepository('.', { limits: { deadlineMs: Number.NaN } }), /deadlineMs/);
  assert.throws(
    () => scanRepository('.', { limits: { maxFiles: DEFAULT_REPOSITORY_SCAN_LIMITS.maxFiles + 1 } }),
    /maxFiles must not exceed/,
  );
  assert.throws(
    () => scanRepository('.', { limits: { deadlineMs: DEFAULT_REPOSITORY_SCAN_LIMITS.deadlineMs + 1 } }),
    /deadlineMs must not exceed/,
  );
});

test('repository scan reports stable reasons when entry or file limits are zero', () => {
  const root = tempRepository();
  try {
    write(root, 'file.txt', 'text');

    const noEntries = scan(root, { limits: { maxEntries: 0 } });
    assert.deepEqual(noEntries.stoppedBy, ['entry-limit']);
    assert.equal(noEntries.stats.entriesVisited, 0);
    assert.deepEqual(noEntries.files, []);

    const noFiles = scan(root, { limits: { maxFiles: 0 } });
    assert.deepEqual(noFiles.stoppedBy, ['file-limit']);
    assert.equal(noFiles.stats.filesRead, 0);
    assert.deepEqual(noFiles.files, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
