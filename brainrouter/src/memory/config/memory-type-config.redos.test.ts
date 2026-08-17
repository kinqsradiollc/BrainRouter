import { describe, it, expect } from 'vitest';
import { extractFilePathHints } from './memory-type-config.js';

// ADR-039 — extractFilePathHints runs over the raw recall query (attacker-
// controlled for an @mention-triggered job) at recall/pipeline.ts. The path regex
// backtracked quadratically on a long unbroken class-member run (~6s on 40k chars).
describe('extractFilePathHints ReDoS guard (ADR-039)', () => {
  it('preserves real hints (incl. the pre-existing js<json alternation quirk)', () => {
    const legit = 'see src/foo/bar.ts and assets/logo.png plus config.json and docs/notes.md';
    // 'config.json' matches as 'config.js' because 'js' precedes 'json' in the
    // alternation — unchanged pre-existing behavior, asserted so the guard can't drift it.
    expect(extractFilePathHints(legit)).toEqual([
      'src/foo/bar.ts', 'assets/logo.png', 'config.js', 'docs/notes.md',
    ]);
  });

  it('is linear on a pathological unbroken run (no catastrophic backtracking)', () => {
    const evil = '.'.repeat(80_000);
    const start = performance.now();
    expect(extractFilePathHints(evil)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
