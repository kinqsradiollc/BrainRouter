/**
 * A list of every file in the workspace is not an answer.
 *
 * `glob_files` tests an unanchored pattern against each BASENAME, so `*` —
 * which the tool's own description offers as an example — matches at every
 * depth and returns the whole tree. A real session (3cbe409e…) called
 * `glob_files {"pattern":"*"}` seventeen times against a 19,217-file
 * workspace: 2.2 MB of paths per call, ~37 MB of the session's 67 MB of tool
 * output, none of it usable by any model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GLOB_MAX_MATCHES, fsReadHandlers } from '../extension/builtin/handlers/fsRead.js';

function workspaceWith(fileCount: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-glob-'));
  for (let i = 0; i < fileCount; i += 1) {
    const dir = path.join(root, `d${i % 25}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i}.ts`), '//');
  }
  return root;
}

async function glob(root: string, pattern: string): Promise<any> {
  const handler = fsReadHandlers.glob_files!;
  const text = await handler({ args: { pattern }, host: { workspaceRoot: root } } as never);
  return JSON.parse(text);
}

test('a pattern that matches the whole tree is capped, counted, and explained', async () => {
  const root = workspaceWith(GLOB_MAX_MATCHES + 250);
  try {
    const out = await glob(root, '*');
    assert.equal(out.matches.length, GLOB_MAX_MATCHES, 'the list stops being unbounded');
    assert.equal(out.truncated.total, GLOB_MAX_MATCHES + 250, 'but the true count is reported');
    assert.match(out.truncated.advice, /too many to be an answer/);
    assert.match(out.truncated.advice, /Narrow it/);
    // The sentence that stops the re-glob, the same way the read path stops the re-read.
    assert.match(out.truncated.advice, /Re-running this same pattern returns this same truncated list/);
    assert.ok(JSON.stringify(out).length < 200_000, 'and the payload is a size a context window can hold');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an ordinary glob is untouched — a plain array, no envelope', async () => {
  const root = workspaceWith(10);
  try {
    const out = await glob(root, '*.ts');
    assert.ok(Array.isArray(out), 'still just the list');
    assert.equal(out.length, 10);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
