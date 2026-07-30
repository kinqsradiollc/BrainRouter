import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAccountReviewAssurance,
  listAccountReviewJobs,
} from './reviewAccountClient.js';

const target = { baseUrl: 'https://brain.example', apiKey: 'secret' };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('CLI review client lists bounded organization review summaries', async () => {
  let request: { url: string; authorization: string | null } | undefined;
  const result = await listAccountReviewJobs(target, async (input, init) => {
    request = {
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    };
    return response({
      canRun: false,
      reviews: [{
        id: 'review-one',
        lens: 'pentest',
        status: 'partial',
        repo: 'owner/repository',
        prNumber: 42,
        findings: 2,
        blocking: 1,
        skipped: null,
        error: null,
        updatedAt: '2026-07-29T00:00:00.000Z',
        createdAt: '2026-07-29T00:00:00.000Z',
      }],
    });
  });
  assert.deepEqual(request, {
    url: 'https://brain.example/api/admin/reviews/jobs?limit=30',
    authorization: 'Bearer secret',
  });
  assert.equal(result.canRun, false);
  assert.equal(result.reviews[0].lens, 'pentest');
});

test('CLI review client encodes opaque job ids and rejects malformed detail', async () => {
  let url = '';
  await assert.rejects(
    getAccountReviewAssurance(target, 'job/one', async (input) => {
      url = String(input);
      return response({ review: {}, assurance: null, canRun: true });
    }),
    /invalid assurance detail/,
  );
  assert.equal(url, 'https://brain.example/api/admin/reviews/jobs/job%2Fone');
});
