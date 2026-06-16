import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWorkspaceEntry, isWorkspaceDirectory } from './fsRead.js';
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
test('a path escaping the workspace is rejected', () => {
    const r = readWorkspaceEntry(tmp(), '../../etc/passwd');
    assert.equal(r.error, 'path escapes the workspace');
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
