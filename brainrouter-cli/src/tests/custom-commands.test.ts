import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseCustomCommand,
  expandCommandBody,
  loadCustomCommands,
  findCustomCommand,
  customCommandsDir,
} from '../runtime/commands/customCommands.js';

test('parseCustomCommand: frontmatter description + body', () => {
  const def = parseCustomCommand('sec-review.md', '---\ndescription: Security review\n---\nReview the diff: $ARGUMENTS\n');
  assert.ok(def);
  assert.equal(def!.name, '/sec-review');
  assert.equal(def!.description, 'Security review');
  assert.equal(def!.body, 'Review the diff: $ARGUMENTS');
});

test('parseCustomCommand: no frontmatter → default description; empty body → null', () => {
  const def = parseCustomCommand('quick.md', 'Do the quick thing.');
  assert.ok(def);
  assert.equal(def!.name, '/quick');
  assert.match(def!.description, /quick\.md/);
  assert.equal(parseCustomCommand('empty.md', '---\ndescription: x\n---\n   \n'), null);
  assert.equal(parseCustomCommand('bad name!.md', 'body'), null);
});

test('expandCommandBody: $ARGUMENTS + positional $1..$9', () => {
  assert.equal(expandCommandBody('Fix $ARGUMENTS now', ['the', 'bug']), 'Fix the bug now');
  assert.equal(expandCommandBody('First=$1 Second=$2 Missing=$3', ['a', 'b']), 'First=a Second=b Missing=');
  assert.equal(expandCommandBody('Cost is $100 and $ARGS stays', ['x']), 'Cost is $100 and $ARGS stays');
  assert.equal(expandCommandBody('No args: [$ARGUMENTS]', []), 'No args: []');
});

test('loadCustomCommands + findCustomCommand: scans the workspace dir', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'br-cmds-'));
  try {
    const dir = customCommandsDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ship-it.md'), '---\ndescription: Ship checklist\n---\nRun the ship checklist for $1.');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a command');
    fs.writeFileSync(path.join(dir, 'broken .md'), 'bad name, skipped');

    const defs = loadCustomCommands(ws);
    assert.equal(defs.length, 1);
    assert.equal(defs[0].name, '/ship-it');
    assert.ok(findCustomCommand(defs, '/ship-it'));
    assert.equal(findCustomCommand(defs, '/nope'), undefined);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('loadCustomCommands: no directory → []', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'br-nocmds-'));
  try {
    assert.deepEqual(loadCustomCommands(ws), []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
