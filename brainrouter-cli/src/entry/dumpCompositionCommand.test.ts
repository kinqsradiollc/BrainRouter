// ADR-041 A41-11 — the dump-composition command IS the genuine consumer of the
// overlay resolver: `--profile minimal` renders a derived profile whose apiRoutes
// row is overlaid off, tagged by the layer that set it. This is a DIFFERENT test
// from the core unit test (profile-overlay.test.ts) — one proves the resolver, one
// proves the live caller — per the inert-value-sweep doctrine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { registerDumpCompositionCommand } from './dumpCompositionCommand.js';

async function runDump(args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const program = new Command();
  program.exitOverride();
  registerDumpCompositionCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'brainrouter', 'dump-composition', ...args]);
  } catch {
    // exitOverride throws on commander-level errors; the action's own errors set
    // process.exitCode instead. Either way we inspect the captured streams.
  }
  const exitCode = process.exitCode;
  console.log = origLog;
  console.error = origErr;
  process.exitCode = origExit;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

test('A41-11 — `--profile minimal` renders the derived profile with apiRoutes overlaid off', async () => {
  const { out } = await runDump(['--profile', 'minimal']);
  assert.match(out, /Derived profile: minimal/);
  assert.match(out, /base: server/);
  // apiRoutes is inactive AND attributed to the overlay layer.
  assert.match(out, /·\s+apiRoutes\s+\[overlay:minimal\]/);
  // A base row the overlay did not touch stays active and base-tagged.
  assert.match(out, /✓\s+mcpTools\s+\[base\]/);
});

test('A41-11 — a host profile still renders (unchanged path)', async () => {
  const { out } = await runDump(['--profile', 'gateway']);
  assert.match(out, /Host profile: gateway/);
});

test('A41-11 — an unknown profile exits 1 and names both host and derived ids', async () => {
  const { err, exitCode } = await runDump(['--profile', 'bogus']);
  assert.equal(exitCode, 1);
  assert.match(err, /Unknown profile "bogus"/);
  assert.match(err, /minimal/);
  assert.match(err, /gateway/);
});
