import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadReviewInstructions, buildReviewInstructionBlock, REVIEW_INSTRUCTION_FILES } from '../review/reviewInstructions.js';

function ws(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-instr-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('REVIEW-MD: no file → null loader, empty block', () => {
  const { dir, cleanup } = ws();
  try {
    assert.equal(loadReviewInstructions(dir), null);
    assert.equal(buildReviewInstructionBlock(dir), '');
  } finally { cleanup(); }
});

test('REVIEW-MD: reads REVIEW.md verbatim + wraps it as a highest-priority block', () => {
  const { dir, cleanup } = ws();
  try {
    fs.writeFileSync(path.join(dir, 'REVIEW.md'), '# Rules\nReport at most 5 nits.\n', 'utf8');
    const found = loadReviewInstructions(dir);
    assert.ok(found);
    assert.equal(found!.source, 'REVIEW.md');
    assert.equal(found!.truncated, false);
    assert.ok(found!.text.includes('Report at most 5 nits.'));
    const block = buildReviewInstructionBlock(dir);
    assert.ok(block.includes('Repository review instructions (REVIEW.md)'));
    assert.ok(block.includes('takes precedence'), 'scoped precedence over default guidance');
    assert.ok(/can NOT relax your read-only/i.test(block), 'safety fence: cannot relax permissions / exfiltrate');
    assert.ok(block.includes('Report at most 5 nits.'));
    assert.ok(block.endsWith('\n'), 'trailing newline so it prepends cleanly');
  } finally { cleanup(); }
});

test('REVIEW-MD: an empty/whitespace REVIEW.md is treated as absent', () => {
  const { dir, cleanup } = ws();
  try {
    fs.writeFileSync(path.join(dir, 'REVIEW.md'), '   \n\n', 'utf8');
    assert.equal(loadReviewInstructions(dir), null);
    assert.equal(buildReviewInstructionBlock(dir), '');
  } finally { cleanup(); }
});

test('REVIEW-MD: precedence — REVIEW.md wins over .review.md', () => {
  const { dir, cleanup } = ws();
  try {
    // Write in REVERSE precedence order to prove order comes from the list, not the FS.
    fs.writeFileSync(path.join(dir, '.review.md'), 'secondary', 'utf8');
    fs.writeFileSync(path.join(dir, 'REVIEW.md'), 'primary', 'utf8');
    assert.equal(REVIEW_INSTRUCTION_FILES[0], 'REVIEW.md');
    assert.equal(loadReviewInstructions(dir)!.text, 'primary');
  } finally { cleanup(); }
});

test('REVIEW-MD: oversized REVIEW.md is capped + flagged truncated', () => {
  const { dir, cleanup } = ws();
  try {
    fs.writeFileSync(path.join(dir, 'REVIEW.md'), 'x'.repeat(20_000), 'utf8');
    const found = loadReviewInstructions(dir)!;
    assert.equal(found.truncated, true);
    assert.ok(found.text.length < 20_000);
    assert.ok(found.text.endsWith('…(truncated)'));
  } finally { cleanup(); }
});

test('REVIEW-MD: empty workspaceRoot → null (never throws)', () => {
  assert.equal(loadReviewInstructions(''), null);
  assert.equal(buildReviewInstructionBlock(''), '');
});
