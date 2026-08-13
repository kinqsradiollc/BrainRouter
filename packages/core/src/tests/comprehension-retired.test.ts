/**
 * ADR-028 Part F — the comprehension cluster is retired, and stays retired.
 *
 * F1–F6 were built, typechecked, tested, and reached by nothing. Twice: the
 * ADR's own "Bugs found" section already records the comprehension panel
 * shipping with no caller, and the modules behind it were unreachable again on
 * the second audit. The third option — leave them exported with a comment
 * saying nothing calls them — is what produced both rounds, so they were
 * deleted instead.
 *
 * The assertion that matters is the SECOND one. The reason a reachability sweep
 * certified six uncalled modules as wired is that `package.json`'s `exports`
 * map credited `./comprehension`, and E1's walk treats an exported subpath as
 * an entry point a user can reach. The subpath was the laundering, so removing
 * the files without removing the subpath would leave the mechanism intact for
 * whatever is put there next.
 *
 * What is NOT retired, and must not be deleted by anyone reading this: F7's
 * Understand panel, its "Review my understanding" button and the host handlers
 * behind them. Those are reachable and they work — the review is written by the
 * agent in chat, which is the only place the questions can honestly come from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(CORE, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('ADR-028 F1–F6 — the comprehension modules stay deleted', () => {
  // Deleted rather than wired because wiring each one meant inventing the
  // product it describes: an Explain panel (F2), a decision store (F3), a
  // Verification panel (F4), a tutor mode the ADR's own open question doubts
  // belongs here (F5), and a research-claim pipeline (F6). F4's job — say what
  // you could NOT check — is already done, on every turn, by
  // `agent/guards/verificationGate.ts`.
  assert.equal(
    existsSync(path.join(SRC, 'comprehension')),
    false,
    'packages/core/src/comprehension came back. Give it a caller a user can reach, or leave it deleted.',
  );
});

test('ADR-028 E1/F — the exports map no longer credits ./comprehension as reachable', () => {
  // The specific hole. `exportedEntryPoints()` in the inert-value sweep seeds
  // its reachability walk from every subpath in this map, so a subpath is a
  // claim that a consumer can get there. Six modules nothing called satisfied
  // the sweep on the strength of this one line.
  const pkg = JSON.parse(readFileSync(path.join(CORE, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  assert.equal(
    Object.hasOwn(pkg.exports ?? {}, './comprehension'),
    false,
    'The ./comprehension subpath is back. An exported subpath tells the reachability sweep a user can get there — do not re-add it for code no surface calls.',
  );
});

test('ADR-028 F1–F6 — nothing in core imports the retired cluster', () => {
  // Belt to the braces above: a re-add under a different directory name still
  // fails here the moment anything imports it, and a re-add nothing imports is
  // the orphan the sweep counts.
  const offenders = walk(SRC)
    .filter((f) => !f.endsWith('.test.ts') && !f.includes(`${path.sep}tests${path.sep}`))
    .filter((f) => /from\s+['"][^'"]*comprehension\/(profileComprehension|workRecord|comprehensionReview|index)\.js['"]/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f));
  assert.deepEqual(offenders, [], `These import a retired comprehension module:\n${offenders.join('\n')}`);
});
