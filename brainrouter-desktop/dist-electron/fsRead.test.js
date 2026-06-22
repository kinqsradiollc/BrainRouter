import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enableLiteralAsarWorkspacePaths, readWorkspaceEntry, isWorkspaceDirectory, listWorkspaceFiles, statWorkspaceEntry, writeWorkspaceEntry, } from './fsRead.js';
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsr-')));
test('reads a normal file', () => {
    const ws = tmp();
    fs.writeFileSync(path.join(ws, 'a.txt'), 'hello world');
    const r = readWorkspaceEntry(ws, 'a.txt');
    assert.equal(r.kind, 'file');
    assert.equal(r.content, 'hello world');
    assert.equal(r.error, undefined);
});
test('reading a DIRECTORY returns a typed listing, not a raw EISDIR error', () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'x.ts'), '');
    fs.mkdirSync(path.join(ws, 'src', 'sub'));
    const r = readWorkspaceEntry(ws, 'src');
    assert.equal(r.kind, 'directory');
    assert.equal(r.error, undefined, 'no EISDIR surfaced');
    assert.ok(r.entries && r.entries.some((e) => e.name === 'x.ts' && !e.dir));
    assert.ok(r.entries && r.entries.some((e) => e.name === 'sub' && e.dir));
    assert.ok(r.content.includes('sub/'), 'listing text marks directories');
});
test('reading the workspace root (".") lists entries', () => {
    const ws = tmp();
    fs.writeFileSync(path.join(ws, 'a.txt'), '');
    const r = readWorkspaceEntry(ws, '.');
    assert.equal(r.kind, 'directory');
});
test('listWorkspaceFiles walks non-git workspaces with bounds and ignored dependency dirs', () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, 'src'));
    fs.mkdirSync(path.join(ws, 'node_modules'));
    fs.mkdirSync(path.join(ws, '.git'));
    fs.writeFileSync(path.join(ws, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(ws, 'README.md'), '');
    fs.writeFileSync(path.join(ws, 'node_modules', 'pkg.js'), '');
    fs.writeFileSync(path.join(ws, '.git', 'config'), '');
    const r = listWorkspaceFiles(ws, { limit: 10 });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.files.sort(), ['README.md', 'src/a.ts']);
    assert.equal(r.truncated, false);
});
test('workspace file reads keep .asar paths literal and do not descend into archive-looking directories', () => {
    const ws = tmp();
    enableLiteralAsarWorkspacePaths();
    assert.equal(process.noAsar, true);
    fs.writeFileSync(path.join(ws, 'bad-fixture.asar'), 'not an archive');
    fs.mkdirSync(path.join(ws, 'packed.asar'));
    fs.writeFileSync(path.join(ws, 'packed.asar', 'inner.txt'), 'hidden');
    const listed = listWorkspaceFiles(ws, { limit: 10 });
    assert.equal(listed.error, undefined);
    assert.ok(listed.files.includes('bad-fixture.asar'));
    assert.ok(!listed.files.includes('packed.asar/inner.txt'));
    const stat = statWorkspaceEntry(ws, 'bad-fixture.asar');
    assert.equal(stat.exists, true);
    assert.equal(stat.kind, 'file');
});
test('listWorkspaceFiles reports truncation at the requested limit', () => {
    const ws = tmp();
    for (let i = 0; i < 4; i++)
        fs.writeFileSync(path.join(ws, `f${i}.txt`), '');
    const r = listWorkspaceFiles(ws, { limit: 2 });
    assert.equal(r.files.length, 2);
    assert.equal(r.truncated, true);
});
test('a path escaping the workspace is rejected', () => {
    const r = readWorkspaceEntry(tmp(), '../../etc/passwd');
    assert.equal(r.error, 'path escapes the workspace');
});
test('a symlink that escapes the workspace is rejected (read path)', () => {
    const ws = tmp();
    const outside = tmp();
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'TOP SECRET');
    // A symlink that LIVES inside the workspace but points outside it: the path
    // string is contained, so only the realpath check catches the escape.
    fs.symlinkSync(secret, path.join(ws, 'link.txt'));
    const r = readWorkspaceEntry(ws, 'link.txt');
    assert.match(r.error ?? '', /escapes the workspace/);
    assert.equal(r.content, '');
});
test('a missing file returns a friendly error, not a crash', () => {
    const r = readWorkspaceEntry(tmp(), 'nope.txt');
    assert.equal(r.kind, 'file');
    assert.ok(r.error && /ENOENT|no such/i.test(r.error));
});
test('isWorkspaceDirectory: true for dirs, false for files / missing / escape', () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, 'd'));
    fs.writeFileSync(path.join(ws, 'f.txt'), '');
    assert.equal(isWorkspaceDirectory(ws, 'd'), true);
    assert.equal(isWorkspaceDirectory(ws, 'f.txt'), false, 'a file is not a directory (diff proceeds)');
    assert.equal(isWorkspaceDirectory(ws, 'missing'), false);
    assert.equal(isWorkspaceDirectory(ws, '../x'), false);
});
// ── editor backend: stat / read(binary,mtime) / write(guards) ────────────────
test('reading a file exposes mtimeMs + size for stale-write round-tripping', () => {
    const ws = tmp();
    fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');
    const r = readWorkspaceEntry(ws, 'a.txt');
    assert.equal(r.size, 5);
    assert.equal(typeof r.mtimeMs, 'number');
    assert.equal(r.binary, undefined);
});
test('a binary file (NUL byte) is flagged and returns empty content', () => {
    const ws = tmp();
    fs.writeFileSync(path.join(ws, 'bin'), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
    const r = readWorkspaceEntry(ws, 'bin');
    assert.equal(r.binary, true);
    assert.equal(r.content, '');
    assert.equal(r.size, 5);
});
test('statWorkspaceEntry: file / directory / missing / escape', () => {
    const ws = tmp();
    fs.writeFileSync(path.join(ws, 'f.txt'), 'abc');
    fs.mkdirSync(path.join(ws, 'd'));
    const f = statWorkspaceEntry(ws, 'f.txt');
    assert.equal(f.exists, true);
    assert.equal(f.kind, 'file');
    assert.equal(f.size, 3);
    assert.equal(typeof f.mtimeMs, 'number');
    assert.equal(statWorkspaceEntry(ws, 'd').kind, 'directory');
    assert.deepEqual({ exists: statWorkspaceEntry(ws, 'missing').exists }, { exists: false });
    assert.equal(statWorkspaceEntry(ws, '../../etc/passwd').error, 'path escapes the workspace');
});
test('writeWorkspaceEntry: saves a file INSIDE the workspace', () => {
    const ws = tmp();
    const r = writeWorkspaceEntry(ws, 'sub/new.ts', 'export const x = 1;');
    // parent must exist (we do not create dirs implicitly)
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /parent directory does not exist/);
    fs.mkdirSync(path.join(ws, 'sub'));
    const r2 = writeWorkspaceEntry(ws, 'sub/new.ts', 'export const x = 1;');
    assert.equal(r2.ok, true);
    assert.equal(fs.readFileSync(path.join(ws, 'sub', 'new.ts'), 'utf-8'), 'export const x = 1;');
    assert.equal(typeof r2.mtimeMs, 'number');
});
test('writeWorkspaceEntry: path traversal is rejected (no write)', () => {
    const ws = tmp();
    const r = writeWorkspaceEntry(ws, '../escape.txt', 'pwned');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'path escapes the workspace');
    assert.equal(fs.existsSync(path.join(ws, '..', 'escape.txt')), false);
});
test('writeWorkspaceEntry: stale-write detection via expectedMtimeMs', () => {
    const ws = tmp();
    const p = path.join(ws, 'a.txt');
    fs.writeFileSync(p, 'v1');
    const opened = fs.statSync(p).mtimeMs;
    // simulate the file changing on disk after it was opened in the editor
    const future = opened + 5000;
    fs.utimesSync(p, new Date(future), new Date(future));
    const conflict = writeWorkspaceEntry(ws, 'a.txt', 'v2', { expectedMtimeMs: opened });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    assert.equal(fs.readFileSync(p, 'utf-8'), 'v1', 'stale write did NOT clobber the file');
    // saving with the CURRENT mtime succeeds
    const fresh = writeWorkspaceEntry(ws, 'a.txt', 'v2', { expectedMtimeMs: fs.statSync(p).mtimeMs });
    assert.equal(fresh.ok, true);
    assert.equal(fs.readFileSync(p, 'utf-8'), 'v2');
});
test('writeWorkspaceEntry: expectedMtimeMs on a deleted file is a conflict, not a recreate', () => {
    const ws = tmp();
    const r = writeWorkspaceEntry(ws, 'gone.txt', 'x', { expectedMtimeMs: 123 });
    assert.equal(r.conflict, true);
});
test('writeWorkspaceEntry: refuses to overwrite a directory', () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, 'd'));
    assert.equal(writeWorkspaceEntry(ws, 'd', 'x').error, 'path is a directory');
});
test('writeWorkspaceEntry: a symlinked directory escaping the workspace is rejected', () => {
    const ws = tmp();
    const outside = tmp(); // a sibling temp dir OUTSIDE the workspace
    fs.symlinkSync(outside, path.join(ws, 'link'));
    const r = writeWorkspaceEntry(ws, 'link/evil.txt', 'pwned');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /symlink/);
    assert.equal(fs.existsSync(path.join(outside, 'evil.txt')), false, 'no write escaped through the symlink');
});
