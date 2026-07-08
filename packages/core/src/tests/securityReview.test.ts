import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSecurityReviewContract,
  isBlockingSecurityFinding,
  SECURITY_LENS,
  SECURITY_REVIEW_MARKER,
  SECURITY_VULN_CLASSES,
} from '../review/securityReview.js';
import { buildCodeReviewContract, CODE_REVIEW_LENS, CODE_REVIEW_AXES, CODE_REVIEW_MARKER } from '../review/codeReviewContract.js';
import {
  buildReviewIntro,
  formatInlineFinding,
  formatReviewSummaryComment,
  inlineFindingMarker,
  inlineMarkerRegex,
} from '../review/reviewLens.js';
import { addedLinesByPath, resolveInlineAnchor, parseReviewFindings } from '../review/reviewFindings.js';
import type { ParsedReviewFinding } from '../review/reviewFindings.js';

const f = (o: Partial<ParsedReviewFinding>): ParsedReviewFinding => ({ file: 'a.ts', severity: 'high', confidence: 80, summary: 's', ...o });

test('security contract is self-contained, diff-focused, and requests a suggestion replacement', () => {
  const c = buildSecurityReviewContract();
  assert.ok(c.includes('SQL / NoSQL injection'));
  assert.ok(c.includes('SSRF'));
  assert.ok(c.includes('```json')); // parseReviewFindings reads the fenced JSON array
  assert.ok(c.includes('replacement')); // drives the GitHub ```suggestion block
  assert.ok(/NO tools/i.test(c)); // must NOT tell a single-shot model to "verify with tools"
  assert.ok(SECURITY_VULN_CLASSES.length > 15);
});

test('code-review contract is self-contained, quality-focused, and defers security', () => {
  const c = buildCodeReviewContract();
  assert.ok(/Correctness/i.test(c));
  assert.ok(/Performance/i.test(c));
  assert.ok(/NOT security/i.test(c)); // security is the other lens — no double-reporting
  assert.ok(c.includes('```json'));
  assert.ok(c.includes('replacement'));
  assert.ok(CODE_REVIEW_AXES.length >= 5);
});

test('no findings → clean summary comment carrying the lens marker', () => {
  const out = formatReviewSummaryComment(SECURITY_LENS, { findings: [], headSha: 'abcdef1234' });
  assert.ok(out.startsWith(SECURITY_REVIEW_MARKER));
  assert.match(out, /No security issues found/);
  assert.ok(out.includes('abcdef1'));
  const code = formatReviewSummaryComment(CODE_REVIEW_LENS, { findings: [], headSha: 'abcdef1234' });
  assert.ok(code.startsWith(CODE_REVIEW_MARKER));
  assert.match(code, /No code-quality issues found/);
});

test('findings sort by severity; blocking excludes pre-existing', () => {
  const findings = [
    f({ severity: 'low', summary: 'nit' }),
    f({ severity: 'critical', summary: 'rce' }),
    f({ severity: 'high', summary: 'pre', preExisting: true }),
  ];
  const out = formatReviewSummaryComment(SECURITY_LENS, { findings, headSha: 'deadbeef' });
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
  const out = formatReviewSummaryComment(SECURITY_LENS, { findings, headSha: 'x', maxListed: 20 });
  assert.match(out, /plus 5 more finding/);
});

test('addedLinesByPath maps RIGHT-side added lines per file', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,4 @@',
    ' const keep = 1;',   // context → line 1
    '+const added2 = 2;',  // + → line 2
    '+const added3 = 3;',  // + → line 3
    ' const keep4 = 4;',   // context → line 4
    'diff --git a/b.ts b/b.ts',
    '--- /dev/null',
    '+++ b/b.ts',
    '@@ -0,0 +1,1 @@',
    '+only = 1;',          // + → line 1
  ].join('\n');
  const map = addedLinesByPath(diff);
  assert.deepEqual([...(map.get('src/a.ts') ?? [])].sort(), [2, 3]);
  assert.deepEqual([...(map.get('b.ts') ?? [])], [1]);
});

test('resolveInlineAnchor: exact range is suggestable; out-of-diff line → null', () => {
  const added = addedLinesByPath('diff --git a/x.ts b/x.ts\n+++ b/x.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n');
  const exact = resolveInlineAnchor(f({ file: 'x.ts', line: 1, endLine: 2, replacement: 'fixed' }), added);
  assert.deepEqual(exact, { path: 'x.ts', line: 2, startLine: 1, side: 'RIGHT', suggestable: true });
  // No replacement → anchored but not suggestable.
  assert.equal(resolveInlineAnchor(f({ file: 'x.ts', line: 2 }), added)?.suggestable, false);
  // Line not in the diff → cannot anchor.
  assert.equal(resolveInlineAnchor(f({ file: 'x.ts', line: 99 }), added), null);
  // Unknown file → null.
  assert.equal(resolveInlineAnchor(f({ file: 'other.ts', line: 1 }), added), null);
});

test('formatInlineFinding renders a GitHub suggestion block + severity/CWE header', () => {
  const body = formatInlineFinding(SECURITY_LENS, f({ file: 'x.ts', line: 2, summary: '[CWE-89] SQL injection', details: 'req.query.id → sink', replacement: "const q = '?';" }), { suggestable: true });
  assert.ok(body.startsWith(inlineFindingMarker(SECURITY_LENS, f({ file: 'x.ts', summary: '[CWE-89] SQL injection' }))));
  assert.match(body, /### 🟠 SQL injection/); // CWE prefix stripped from the title
  assert.match(body, /\*\*Severity:\*\* HIGH · \*\*CWE-89\*\*/);
  assert.match(body, /```suggestion\nconst q = '\?';\n```/);
  assert.match(body, /Prompt to fix with AI/);
  assert.match(body, /🛡️ BrainRouter security/); // lens footer
});

test('formatInlineFinding without a safe replacement falls back to a prose fix', () => {
  const body = formatInlineFinding(SECURITY_LENS, f({ summary: 'x', suggestion: 'do the thing', replacement: 'code' }), { suggestable: false });
  assert.ok(!body.includes('```suggestion'));
  assert.match(body, /\*\*Fix:\*\* do the thing/);
});

test('inline markers are lens-scoped so security + code review never clobber each other', () => {
  const finding = f({ file: 'x.ts', summary: '[CWE-89] SQL injection' });
  const sec = inlineFindingMarker(SECURITY_LENS, finding);
  const code = inlineFindingMarker(CODE_REVIEW_LENS, finding);
  assert.equal(sec, '<!-- brs-finding:x-ts-cwe-89-sql-injection -->');
  assert.equal(code, '<!-- brc-finding:x-ts-cwe-89-sql-injection -->');
  assert.notEqual(sec, code);
  assert.ok(inlineMarkerRegex(SECURITY_LENS).test(sec));
  assert.ok(!inlineMarkerRegex(SECURITY_LENS).test(code)); // security dedup ignores code-review markers
  assert.ok(inlineMarkerRegex(CODE_REVIEW_LENS).test(code));
});

test('buildReviewIntro counts new findings per lens', () => {
  assert.match(buildReviewIntro(SECURITY_LENS, 3), /flagged \*\*3\*\* new security findings/);
  assert.match(buildReviewIntro(SECURITY_LENS, 1), /flagged \*\*1\*\* new security finding\b/);
  assert.match(buildReviewIntro(SECURITY_LENS, 0), /no new security findings/i);
  assert.match(buildReviewIntro(CODE_REVIEW_LENS, 2), /flagged \*\*2\*\* new code-review findings/);
});

test('parseReviewFindings reads the replacement field', () => {
  const out = parseReviewFindings('```json\n[{"file":"x.ts","summary":"s","replacement":"fixed code"}]\n```');
  assert.equal(out[0]?.replacement, 'fixed code');
});
