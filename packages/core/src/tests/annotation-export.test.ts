import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnnotationRecord } from '@kinqs/brainrouter-types';
import { annotationsToMarkdown } from '../annotation/annotationExport.js';

function rec(over: Partial<AnnotationRecord>): AnnotationRecord {
  return {
    id: 'ann_00000000',
    type: 'file',
    workspaceRoot: '/w',
    body: 'body',
    status: 'open',
    linkedMemoryIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('annotationsToMarkdown: empty list yields a placeholder document', () => {
  const md = annotationsToMarkdown([]);
  assert.match(md, /^# Annotations/);
  assert.match(md, /No annotations to export/);
});

test('annotationsToMarkdown: groups by target/file and renders anchor, status, severity, body', () => {
  const md = annotationsToMarkdown([
    rec({
      id: 'ann_aaa',
      type: 'file',
      anchor: { filePath: 'src/app.ts', startLine: 10, endLine: 14 },
      severity: 'high',
      status: 'open',
      body: 'Off-by-one in the loop',
    }),
    rec({
      id: 'ann_bbb',
      type: 'requirement',
      targetId: 'req_xyz',
      status: 'accepted',
      body: 'Acceptance criteria look good',
    }),
  ]);

  // Two group headings, one per (kind · file|targetId).
  assert.match(md, /## file · src\/app\.ts/);
  assert.match(md, /## requirement · req_xyz/);
  // Anchor location with a line range.
  assert.match(md, /at: src\/app\.ts:10-14/);
  // Status + severity metadata.
  assert.match(md, /status: open, severity: high/);
  assert.match(md, /status: accepted/);
  // Bodies.
  assert.match(md, /Off-by-one in the loop/);
  assert.match(md, /Acceptance criteria look good/);
  // Group order is alphabetical: "file …" sorts before "requirement …".
  assert.ok(md.indexOf('## file') < md.indexOf('## requirement'));
});

test('annotationsToMarkdown: renders suggested code inside a fence and quotes selected text', () => {
  const md = annotationsToMarkdown([
    rec({
      id: 'ann_ccc',
      type: 'diff',
      anchor: { filePath: 'src/x.ts', startLine: 5, selectedText: 'let x = 1' },
      suggestedText: 'const x = 1;\nconst y = 2;',
      body: 'Prefer const',
    }),
  ]);

  // Single-line anchor (no range).
  assert.match(md, /at: src\/x\.ts:5/);
  // Selected text quoted as a blockquote.
  assert.match(md, /> let x = 1/);
  // Suggested code fenced and indented under the bullet.
  assert.match(md, /Suggested:/);
  assert.match(md, /```/);
  assert.match(md, /const x = 1;/);
  assert.match(md, /const y = 2;/);
});

test('annotationsToMarkdown: a global comment (no anchor, no target) groups under its bare kind', () => {
  const md = annotationsToMarkdown([rec({ id: 'ann_ddd', type: 'plan', body: 'Looks good overall' })]);
  assert.match(md, /## plan\b/);
  assert.match(md, /Looks good overall/);
  // No "at:" location for an unanchored global comment.
  assert.doesNotMatch(md, /at:/);
});
