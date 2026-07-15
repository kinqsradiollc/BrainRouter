import test from "node:test";
import assert from "node:assert/strict";
import { clearDashboardQueries, invalidateDashboardQueries, queryDashboard } from "./dashboardQuery";

test("deduplicates concurrent cold reads", async () => {
  clearDashboardQueries();
  let calls = 0;
  let resolve!: (value: number) => void;
  const fetcher = () => { calls += 1; return new Promise<number>((done) => { resolve = done; }); };
  const first = queryDashboard("orgs", fetcher);
  const second = queryDashboard("orgs", fetcher);
  assert.equal(calls, 1);
  resolve(7);
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
});

test("returns stale data immediately while one background refresh runs", async () => {
  clearDashboardQueries();
  let now = 0;
  let calls = 0;
  const fetcher = async () => ++calls;
  assert.equal(await queryDashboard("prs:org-1", fetcher, { ttlMs: 10, now: () => now }), 1);
  now = 11;
  assert.equal(await queryDashboard("prs:org-1", fetcher, { ttlMs: 10, now: () => now }), 1);
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(await queryDashboard("prs:org-1", fetcher, { ttlMs: 10, now: () => now }), 2);
});

test("prefix invalidation keeps unrelated organizations cached", async () => {
  clearDashboardQueries();
  let calls = 0;
  const fetcher = async () => ++calls;
  await queryDashboard("reviews:org-1", fetcher);
  await queryDashboard("reviews:org-2", fetcher);
  invalidateDashboardQueries("reviews:org-1");
  assert.equal(await queryDashboard("reviews:org-1", fetcher), 3);
  assert.equal(await queryDashboard("reviews:org-2", fetcher), 2);
});
