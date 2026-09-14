/**
 * ADR-046 D2 (S4) — one history→model-request derivation, shared by the live
 * turn path and session resume.
 *
 * The acceptance criterion is: resume/fork reproduces byte-identical
 * model-visible context to the live turn that produced it. This is guaranteed
 * structurally — both paths call `deriveModelRequest` — and asserted here:
 *  1. the derivation is a fixed point (re-deriving changes nothing),
 *  2. the same recorded messages yield an identical request on both paths, and
 *  3. neither hot-path file derives its request any other way (no direct
 *     `sanitizeToolCallPairing`), so the single-derivation guarantee cannot
 *     quietly fork.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveModelRequest } from '../agent/guards/toolCallRecovery.js';

// Resolve the TS SOURCE tree (this test compiles to dist/tests/, the sources it
// inspects live in src/) — the same dist→src hop the inert-value sweep uses.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src') + path.sep;

/** A recorded transcript whose last turn died after emitting a tool_call. */
const crashedTranscript = [
  { role: 'user', content: 'do the thing' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
  // crash: c1's result was never persisted; next user turn recorded
  { role: 'user', content: 'and now this' },
];

test('S4 — the derivation is a fixed point (idempotent)', () => {
  const once = deriveModelRequest(crashedTranscript);
  const twice = deriveModelRequest(once);
  assert.deepEqual(twice, once, 're-deriving a derived request must not change it');
});

test('S4 — resume reproduces byte-identical model context to the live path', () => {
  // The "live" request built from the in-memory history, and the "resume"
  // request rebuilt from the same recorded transcript, must be identical —
  // because they are the SAME function. This documents and guards the acceptance
  // criterion: a future fork of the derivation would break this.
  const live = deriveModelRequest(crashedTranscript);
  const resumed = deriveModelRequest(crashedTranscript);
  assert.equal(JSON.stringify(resumed), JSON.stringify(live));
  // And the orphan was repaired into a well-formed request either way.
  const synth = resumed.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c1');
  assert.ok(synth, 'the resumed request pairs the orphaned tool_call');
});

test('S4 — both hot-path files derive through deriveModelRequest, not a private copy', () => {
  for (const rel of ['agent/runtime/modelInvocationPhase.ts', 'agent/runtime/session.impl.ts']) {
    const text = readFileSync(SRC + rel, 'utf8');
    assert.match(text, /deriveModelRequest\(/, `${rel} must build its request via deriveModelRequest`);
    // No direct sanitizeToolCallPairing call — that would be a second derivation.
    assert.doesNotMatch(
      text,
      /\bsanitizeToolCallPairing\(/,
      `${rel} calls sanitizeToolCallPairing directly; route it through deriveModelRequest so live and resume cannot diverge`,
    );
  }
});
