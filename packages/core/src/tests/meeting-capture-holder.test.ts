/**
 * ADR-035 D6 — a capture writer's id is unique per window, on every host.
 *
 * All that is left of the lease, and the only part of it that was ever an
 * answer to the right question. The desktop keys its per-process writer map by
 * this string, so two windows that shared one would be indistinguishable to
 * main: the window recording a meeting and the window merely looking at it
 * would be the same writer, and the second would be allowed to finalize or
 * delete the recording the first still has a microphone open for.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { newCaptureHolderId } from '../meetings/index.js';

test('a holder id is unique per window, with and without a secure context', () => {
  assert.notEqual(
    newCaptureHolderId(),
    newCaptureHolderId(),
    'two windows sharing a holder id would each mistake the other for itself',
  );
  assert.match(newCaptureHolderId(), /^wr-.+/);

  // The dashboard is not always served from a secure context, so `randomUUID`
  // is not always there — and a fallback that handed every browsing context the
  // same id would defeat the whole thing on exactly the host that has second
  // tabs.
  const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    const ids = new Set(Array.from({ length: 32 }, () => newCaptureHolderId()));
    assert.equal(ids.size, 32, 'the plain-http fallback handed two windows the same holder id');
    for (const id of ids) assert.match(id, /^wr-.+/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', real);
  }
});
