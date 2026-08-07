/**
 * ADR-029 C2 row 6 — "a reference to a file/symbol that survives the file
 * moving", as the four outcomes it decomposes into.
 *
 * The defect these pin was reproducible in one gesture: rename a cited file and
 * the reference reported `never_existed` — which tells the reader their link
 * was a typo when someone had merely moved a directory. A3 calls that the worst
 * answer available, because a document that is confidently wrong is worse than
 * one that is obviously empty, and this one additionally blames the author.
 *
 * So every test here is about a DISTINCTION rather than a feature: moved is not
 * deleted, deleted is not never-existed, never-existed is not "we cannot tell",
 * and a file being present does not mean the symbol in it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildLocalWorkspaceRegistry, declarationOnLine, findCodeSymbol, listCodeSymbols,
  locateCodeFile, localWorkspaceViewer,
} from '../workspace/participants/index.js';
import { parseWorkspaceRef, renderWorkspaceResolution } from '../workspace/references/index.js';

const VIEWER = localWorkspaceViewer({ workspaceRoot: '.' });

const PARSER = [
  'export function parseHeader(input: string): string {',
  '  return input.trim();',
  '}',
  '',
  'export const LIMIT = 10;',
  '',
  'export class Reader {',
  '  read(name: string) {',
  '    return parseHeader(name);',
  '  }',
  '}',
  '',
].join('\n');

function run(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

interface Repo { root: string }

/** A real repository, because the whole question is what git says. */
function repo(): Repo {
  const root = mkdtempSync(path.join(tmpdir(), 'br-code-ref-'));
  run(root, ['init', '-q', '.']);
  run(root, ['config', 'user.email', 'test@example.invalid']);
  run(root, ['config', 'user.name', 'Test']);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'parser.ts'), PARSER);
  run(root, ['add', '-A']);
  run(root, ['commit', '-qm', 'the parser']);
  return { root };
}

function cleanup(fixture: { root: string }): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

function registryFor(root: string) {
  return buildLocalWorkspaceRegistry({ workspaceRoot: root });
}

test('a committed rename resolves to the NEW path, and the label says it moved', async () => {
  const fx = repo();
  try {
    mkdirSync(path.join(fx.root, 'lib'), { recursive: true });
    run(fx.root, ['mv', 'src/parser.ts', 'lib/header.ts']);
    run(fx.root, ['commit', '-qm', 'move the parser']);

    const resolution = await registryFor(fx.root).resolve(
      { mode: 'code', kind: 'file', id: 'src/parser.ts' },
      VIEWER,
    );
    // Following the rename is the correct behaviour (A3: a reference is live),
    // and the label states it rather than pretending nothing happened.
    assert.equal(resolution.status, 'found');
    assert.equal(resolution.status === 'found' && resolution.ref.id, 'lib/header.ts');
    const label = resolution.status === 'found' ? resolution.target.label : '';
    assert.match(label, /lib\/header\.ts/);
    assert.match(label, /moved from src\/parser\.ts/);
  } finally { cleanup(fx); }
});

test('a rename that is staged but not committed is followed too — a branch mid-flight still resolves', async () => {
  const fx = repo();
  try {
    run(fx.root, ['mv', 'src/parser.ts', 'src/header.ts']);
    const resolution = await registryFor(fx.root).resolve(
      { mode: 'code', kind: 'file', id: 'src/parser.ts' },
      VIEWER,
    );
    assert.equal(resolution.status, 'found');
    assert.equal(resolution.status === 'found' && resolution.ref.id, 'src/header.ts');
  } finally { cleanup(fx); }
});

test('a committed deletion is a DATED tombstone, not "never existed"', async () => {
  const fx = repo();
  try {
    run(fx.root, ['rm', '-q', 'src/parser.ts']);
    run(fx.root, ['commit', '-qm', 'drop the parser']);

    const resolution = await registryFor(fx.root).resolve(
      { mode: 'code', kind: 'file', id: 'src/parser.ts' },
      VIEWER,
    );
    assert.equal(resolution.status, 'gone');
    // "someone removed it" and "you mistyped it" lead to different actions, so
    // they are never the same sentence.
    assert.equal(resolution.status === 'gone' && resolution.tombstone.reason, 'deleted');
    assert.ok(resolution.status === 'gone' && resolution.tombstone.at);
    assert.match(renderWorkspaceResolution(resolution), /deleted \d/);
  } finally { cleanup(fx); }
});

test('a file removed from the working tree only still reports deleted — it existed', async () => {
  const fx = repo();
  try {
    rmSync(path.join(fx.root, 'src', 'parser.ts'));
    const resolution = await registryFor(fx.root).resolve(
      { mode: 'code', kind: 'file', id: 'src/parser.ts' },
      VIEWER,
    );
    assert.equal(resolution.status, 'gone');
    assert.equal(resolution.status === 'gone' && resolution.tombstone.reason, 'deleted');
  } finally { cleanup(fx); }
});

test('never_existed is now TRUE when it is reported: git has no record of the path at all', async () => {
  const fx = repo();
  try {
    const resolution = await registryFor(fx.root).resolve(
      { mode: 'code', kind: 'file', id: 'src/imaginary.ts' },
      VIEWER,
    );
    assert.equal(resolution.status, 'gone');
    assert.equal(resolution.status === 'gone' && resolution.tombstone.reason, 'never_existed');
  } finally { cleanup(fx); }
});

test('a workspace with no repository says it cannot tell, rather than guessing at a tombstone', async () => {
  const plain = mkdtempSync(path.join(tmpdir(), 'br-code-plain-'));
  try {
    const resolution = await registryFor(plain).resolve(
      { mode: 'code', kind: 'file', id: 'src/parser.ts' },
      VIEWER,
    );
    // The fourth status exists precisely for "this surface cannot answer".
    assert.equal(resolution.status, 'unavailable');
    assert.equal(resolution.status === 'unavailable' && resolution.reason, 'no_history_here');
    assert.match(renderWorkspaceResolution(resolution), /nothing here records where it went/);
  } finally { rmSync(plain, { recursive: true, force: true }); }
});

test('a path from a note that escapes the workspace is refused BEFORE any git argv is built', () => {
  const fx = repo();
  const outside = mkdtempSync(path.join(tmpdir(), 'br-code-outside-'));
  try {
    writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n');
    const workspace = path.join(fx.root, 'src');
    for (const hostile of ['../../etc/passwd', path.join(outside, 'secret.txt'), '../parser.ts']) {
      const located = locateCodeFile(workspace, hostile);
      // A note is untrusted content; a reference in one must not be able to
      // point this process, or the subprocess it starts, outside the workspace.
      assert.equal(located.status, 'refused', `${hostile} was not refused`);
    }
  } finally {
    cleanup(fx);
    rmSync(outside, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------- symbols */

test('a symbol resolves to its declaration line, and keeps resolving after the file moves', async () => {
  const fx = repo();
  try {
    const found = await registryFor(fx.root).resolve(
      { mode: 'code', kind: 'symbol', id: 'src/parser.ts', fragment: 'parseHeader' },
      VIEWER,
    );
    assert.equal(found.status, 'found');
    const state = found.status === 'found' ? (found.target.state as Record<string, unknown>) : {};
    assert.equal(state.line, 1);
    assert.equal(state.declaredAs, 'function');
    // A pointer, not a payload — the same rule the file kind holds to.
    assert.equal(JSON.stringify(found).includes('input.trim()'), false);

    mkdirSync(path.join(fx.root, 'lib'), { recursive: true });
    run(fx.root, ['mv', 'src/parser.ts', 'lib/header.ts']);
    run(fx.root, ['commit', '-qm', 'move it']);

    const afterMove = await registryFor(fx.root).resolve(
      { mode: 'code', kind: 'symbol', id: 'src/parser.ts', fragment: 'parseHeader' },
      VIEWER,
    );
    // The two compose: rename following happens first, so a symbol reference
    // survives the move for the same reason the file reference does.
    assert.equal(afterMove.status, 'found');
    assert.equal(afterMove.status === 'found' && afterMove.ref.id, 'lib/header.ts');
    assert.match(afterMove.status === 'found' ? afterMove.target.label : '', /moved from src\/parser\.ts/);
  } finally { cleanup(fx); }
});

test('the file is here and the symbol is not: a removed symbol is dated, an invented one never existed', async () => {
  const fx = repo();
  try {
    writeFileSync(
      path.join(fx.root, 'src', 'parser.ts'),
      PARSER.replace('export function parseHeader', 'export function readHeader'),
    );
    run(fx.root, ['add', '-A']);
    run(fx.root, ['commit', '-qm', 'rename the function']);

    const renamed = await registryFor(fx.root).resolve(
      { mode: 'code', kind: 'symbol', id: 'src/parser.ts', fragment: 'parseHeader' },
      VIEWER,
    );
    assert.equal(renamed.status, 'gone');
    // A renamed function is a different sentence from a deleted file, and the
    // sentence has to name what is missing or the reader cannot act on it.
    assert.equal(renamed.status === 'gone' && renamed.tombstone.reason, 'deleted');
    assert.match(renderWorkspaceResolution(renamed), /parseHeader is no longer in src\/parser\.ts/);

    const invented = await registryFor(fx.root).resolve(
      { mode: 'code', kind: 'symbol', id: 'src/parser.ts', fragment: 'neverWrittenHere' },
      VIEWER,
    );
    assert.equal(invented.status, 'gone');
    assert.equal(invented.status === 'gone' && invented.tombstone.reason, 'never_existed');
  } finally { cleanup(fx); }
});

test('a symbol reference with no name is malformed, not missing', async () => {
  const fx = repo();
  try {
    const resolution = await registryFor(fx.root).resolve(
      { mode: 'code', kind: 'symbol', id: 'src/parser.ts' },
      VIEWER,
    );
    assert.equal(resolution.status, 'unavailable');
    assert.equal(resolution.status === 'unavailable' && resolution.reason, 'malformed_ref');
  } finally { cleanup(fx); }
});

test('the picker and the resolver agree, because one function decides what a declaration is', () => {
  const symbols = listCodeSymbols(PARSER);
  assert.deepEqual(
    symbols.map((s) => [s.name, s.line, s.kind]),
    [['parseHeader', 1, 'function'], ['LIMIT', 5, 'const'], ['Reader', 7, 'class'], ['read', 8, 'member']],
  );
  // Every symbol the picker offers must be one the resolver can find, or a
  // reference is broken the moment it is written.
  for (const symbol of symbols) {
    assert.deepEqual(findCodeSymbol(PARSER, symbol.name), symbol);
    // …and one the URI grammar accepts as a fragment, or the link is never
    // written at all and the click does nothing.
    assert.equal(
      parseWorkspaceRef(`brainrouter://code/symbol/src/parser.ts#${symbol.name}`).ok,
      true,
      `${symbol.name} cannot be addressed`,
    );
  }
  // The cap is the grammar's, so a name too long to address is never offered.
  const long = `export function ${'n'.repeat(70)}() {`;
  assert.equal(declarationOnLine(long)?.name.length, 70);
  assert.deepEqual(listCodeSymbols(long), []);
});

test('a call site is not a declaration — the reference would otherwise point at the wrong line', () => {
  assert.equal(declarationOnLine('  return parseHeader(name);'), null);
  assert.equal(declarationOnLine('const value = parseHeader(name);')?.name, 'value');
  assert.equal(declarationOnLine('  reader.read(name);'), null);
  assert.equal(declarationOnLine('export default async function run(): Promise<void> {')?.name, 'run');
  assert.equal(declarationOnLine('  public static async fetchAll(id: string) {')?.name, 'fetchAll');
  assert.equal(declarationOnLine('def parse_header(line):')?.kind, 'def');
  // A minified bundle is one enormous line; scanning it finds noise, so it is
  // not scanned at all.
  assert.equal(declarationOnLine(`const a=1;${'x'.repeat(4000)}`), null);
});
