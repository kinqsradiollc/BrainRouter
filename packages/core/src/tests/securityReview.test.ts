import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSecurityReviewContract,
  formatSecurityReviewComment,
  isBlockingSecurityFinding,
  SECURITY_REVIEW_MARKER,
  SECURITY_VULN_CLASSES,
} from '../review/securityReview.js';
import type { ParsedReviewFinding } from '../review/reviewFindings.js';

const f = (o: Partial<ParsedReviewFinding>): ParsedReviewFinding => ({ file: 'a.ts', severity: 'high', confidence: 80, summary: 's', ...o });

test('security contract lists the taxonomy + reuses the JSON output contract', () => {
  const c = buildSecurityReviewContract();
  assert.ok(c.includes('SQL / NoSQL injection'));
  assert.ok(c.includes('SSRF'));
  assert.ok(c.includes('```json')); // inherited from REVIEW_OUTPUT_CONTRACT so parseReviewFindings works
  assert.ok(SECURITY_VULN_CLASSES.length > 15);
});

test('no findings → clean comment carrying the idempotency marker', () => {
  const out = formatSecurityReviewComment({ findings: [], headSha: 'abcdef1234' });
  assert.ok(out.startsWith(SECURITY_REVIEW_MARKER));
  assert.match(out, /No security issues found/);
  assert.ok(out.includes('abcdef1'));
});

test('findings sort by severity; blocking excludes pre-existing', () => {
  const findings = [
    f({ severity: 'low', summary: 'nit' }),
    f({ severity: 'critical', summary: 'rce' }),
    f({ severity: 'high', summary: 'pre', preExisting: true }),
  ];
  const out = formatSecurityReviewComment({ findings, headSha: 'deadbeef' });
  assert.ok(out.indexOf('rce') < out.indexOf('nit'), 'critical before low');
  assert.match(out, /\*\*1 blocking\*\*/); // only the critical; the pre-existing high is not blocking
  assert.match(out, /_\(pre-existing\)_/);
});

test('isBlockingSecurityFinding', () => {
  assert.equal(isBlockingSecurityFinding(f({ severity: 'critical' })), true);
  assert.equal(isBlockingSecurityFinding(f({ severity: 'high', preExisting: true })), false);
  assert.equal(isBlockingSecurityFinding(f({ severity: 'low' })), false);
});

test('caps listed findings and tallies the rest', () => {
  const findings = Array.from({ length: 25 }, (_, i) => f({ summary: `finding ${i}`, severity: 'medium' }));
  const out = formatSecurityReviewComment({ findings, headSha: 'x', maxListed: 20 });
  assert.match(out, /plus 5 more finding/);
});
