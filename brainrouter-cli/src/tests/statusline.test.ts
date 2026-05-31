import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEGMENT_NAMES,
  formatTokenCount,
  renderSegment,
  type SegmentInputs,
} from '../cli/statusline.js';

function baseInputs(over: Partial<SegmentInputs> = {}): SegmentInputs {
  return {
    workspaceRoot: '/tmp/nonexistent-workspace-xyz',
    sessionKey: 's:test',
    accessMode: 'read',
    model: 'gpt-test',
    lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    ...over,
  };
}

test('FOOTER-TELEMETRY-2 formatTokenCount: exact under 1k, one-decimal k above', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1.0k');
  assert.equal(formatTokenCount(12345), '12.3k');
  assert.equal(formatTokenCount(1_500_000), '1500.0k');
});

test('FOOTER-TELEMETRY-2 offload segment is in the segment registry', () => {
  assert.ok((SEGMENT_NAMES as readonly string[]).includes('offload'));
});

test('FOOTER-TELEMETRY-2 offload segment: hidden when no totals / nothing spent', () => {
  // No totals object at all.
  assert.equal(renderSegment('offload', baseInputs()), undefined);
  // Totals present but zero on every axis.
  assert.equal(
    renderSegment('offload', baseInputs({
      offloadTotals: { childTokensSpent: 0, offloadCharsAvoided: 0, compactedToolCharsAvoided: 0 },
    })),
    undefined,
  );
});

test('FOOTER-TELEMETRY-2 offload segment: child spend only', () => {
  const out = renderSegment('offload', baseInputs({
    offloadTotals: { childTokensSpent: 12345, offloadCharsAvoided: 0, compactedToolCharsAvoided: 0 },
  }));
  assert.equal(out, 'child:12.3k');
});

test('FOOTER-TELEMETRY-2 offload segment: saved tokens derived from offloaded chars (~4 chars/token)', () => {
  // 8000 chars offloaded ≈ 2000 tokens saved → "saved:~2.0k".
  const out = renderSegment('offload', baseInputs({
    offloadTotals: { childTokensSpent: 0, offloadCharsAvoided: 8000, compactedToolCharsAvoided: 0 },
  }));
  assert.equal(out, 'saved:~2.0k');
});

test('FOOTER-TELEMETRY-2 offload segment: both child spend and savings', () => {
  const out = renderSegment('offload', baseInputs({
    offloadTotals: { childTokensSpent: 4000, offloadCharsAvoided: 8000, compactedToolCharsAvoided: 999 },
  }));
  assert.equal(out, 'child:4.0k saved:~2.0k');
});
