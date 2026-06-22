import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReviewService, ReviewService } from '../review/service.js';
import { getLatestReview } from '../review/reviewStore.js';
import type { ReviewRun } from '../review/reviewModel.js';

test('ReviewService is a per-workspace facade — delegates to the review store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'review-svc-'));
  try {
    const svc = createReviewService(ws);
    assert.ok(svc instanceof ReviewService);
    assert.equal(svc.getLatest(), getLatestReview(ws));
    assert.equal(svc.getLatest(), null);

    const now = new Date().toISOString();
    const run: ReviewRun = {
      id: 'run-1', workspaceRoot: ws, repoRoot: ws, baseRef: 'main', headRef: 'HEAD',
      diffHash: 'abc123', createdAt: now, updatedAt: now, status: 'completed', summary: '1 finding',
      findings: [{
        id: 'f-1', file: 'src/x.ts', severity: 'high', confidence: 0.9,
        summary: 'risky', status: 'open', canApply: false, source: 'ai-review',
      }],
    };
    svc.save(run);
    assert.deepEqual(svc.getLatest(), getLatestReview(ws));
    assert.equal(svc.getLatest()?.id, 'run-1');

    const updated = svc.updateFinding('f-1', 'fixed', new Date().toISOString());
    assert.equal(updated?.findings[0].status, 'fixed');

    svc.clear();
    assert.equal(svc.getLatest(), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
