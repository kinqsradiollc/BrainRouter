/**
 * ADR-027 D13 — reading a stack from GitHub.
 *
 * Everything here is about FAILING SOFT. Stacked PRs are in public preview, so
 * the payload shape can move under us; an unstacked pull request and a shifted
 * endpoint look identical from inside this adapter. Neither may stop a review
 * being published — trading a working security gate for a cosmetic stack banner
 * would be a bad deal at any exchange rate.
 *
 * The one place it must NOT be permissive: a chain it cannot verify must not be
 * used to decide merge order.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fetchPullRequestStack } from "../integrations/githubStack.js";

const headers = (): Record<string, string> => ({ authorization: "token" });

function responder(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function call(fetchImpl: typeof fetch, prNumber = 2): ReturnType<typeof fetchPullRequestStack> {
  return fetchPullRequestStack({
    fetchImpl, apiBase: "https://api.github.com", repo: "o/r", prNumber, token: "t", headers,
  });
}

const THREE_LAYERS = {
  trunk: "main",
  pull_requests: [
    { number: 1, head: { ref: "a" }, base: { ref: "main" }, mergeable_state: "clean" },
    { number: 2, head: { ref: "b" }, base: { ref: "a" }, mergeable_state: "clean" },
    { number: 3, head: { ref: "c" }, base: { ref: "b" }, mergeable_state: "clean" },
  ],
};

test("a well-formed stack is read bottom-first", async () => {
  const { stack } = await call(responder(200, THREE_LAYERS));
  assert.ok(stack);
  assert.equal(stack.trunk, "main");
  assert.deepEqual(stack.layers.map((l) => l.number), [1, 2, 3]);
  assert.equal(stack.layers[0]!.base, "main");
});

test("a 404 means an ordinary unstacked pull request, not an error", async () => {
  const result = await call(responder(404, {}));
  assert.equal(result.stack, null);
  assert.equal(result.reason, "not part of a stack");
});

test("a server error degrades to no stack rather than throwing", async () => {
  const result = await call(responder(500, {}));
  assert.equal(result.stack, null);
  assert.match(result.reason!, /HTTP 500/);
});

test("a network failure degrades to no stack", async () => {
  const boom = (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
  const result = await call(boom);
  assert.equal(result.stack, null);
  assert.match(result.reason!, /socket hang up/);
});

test("an unexpected payload shape degrades instead of inventing a chain", async () => {
  // The preview contract can move. Guessing at a shape we do not recognise
  // would report a merge order that is not real.
  for (const body of [{}, { pull_requests: "nope" }, { pull_requests: [] }, null]) {
    const result = await call(responder(200, body));
    assert.equal(result.stack, null, `for ${JSON.stringify(body)}`);
  }
});

test("a layer missing its number or refs invalidates the whole chain", async () => {
  // A chain we cannot verify must not decide merge order — this is the one
  // place the adapter is deliberately strict rather than permissive.
  const result = await call(responder(200, {
    trunk: "main",
    pull_requests: [
      { number: 1, head: { ref: "a" }, base: { ref: "main" } },
      { head: { ref: "b" }, base: { ref: "a" } },
    ],
  }));
  assert.equal(result.stack, null);
  assert.match(result.reason!, /number or branch refs/);
});

test("a non-linear chain is rejected by validation", async () => {
  const result = await call(responder(200, {
    trunk: "main",
    pull_requests: [
      { number: 1, head: { ref: "a" }, base: { ref: "main" } },
      { number: 2, head: { ref: "b" }, base: { ref: "main" } },
    ],
  }));
  assert.equal(result.stack, null);
  assert.match(result.reason!, /failed validation/);
});

test("a stack that does not contain this pull request is rejected", async () => {
  // Reporting someone else's stack on this PR would be worse than none.
  const result = await call(responder(200, THREE_LAYERS), 99);
  assert.equal(result.stack, null);
  assert.match(result.reason!, /does not contain/);
});

test("readiness is positive-only — unknown mergeable_state is NOT ready", async () => {
  // GitHub returns `unknown` while it computes. Calling that ready produces a
  // merge button that fails when pressed, which is worse than waiting.
  const { stack } = await call(responder(200, {
    trunk: "main",
    pull_requests: [
      { number: 1, head: { ref: "a" }, base: { ref: "main" }, mergeable_state: "unknown" },
      { number: 2, head: { ref: "b" }, base: { ref: "a" }, mergeable_state: "clean" },
    ],
  }));
  assert.equal(stack!.layers[0]!.ready, false);
  assert.equal(stack!.layers[1]!.ready, true);
});

test("a draft layer is never ready, whatever its mergeable_state says", async () => {
  const { stack } = await call(responder(200, {
    trunk: "main",
    pull_requests: [
      { number: 1, head: { ref: "a" }, base: { ref: "main" }, mergeable_state: "clean", draft: true },
      { number: 2, head: { ref: "b" }, base: { ref: "a" }, mergeable_state: "clean" },
    ],
  }));
  assert.equal(stack!.layers[0]!.ready, false);
});

test("`unstable` counts as ready — non-required checks failing is not a block", async () => {
  const { stack } = await call(responder(200, {
    trunk: "main",
    pull_requests: [
      { number: 1, head: { ref: "a" }, base: { ref: "main" }, mergeable_state: "unstable" },
      { number: 2, head: { ref: "b" }, base: { ref: "a" }, mergeable_state: "clean" },
    ],
  }));
  assert.equal(stack!.layers[0]!.ready, true);
});

test("plain string refs and a base_ref trunk are both accepted", async () => {
  // The preview payload is not fully settled; accepting both shapes costs
  // nothing and avoids a hard failure on a cosmetic difference.
  const { stack } = await call(responder(200, {
    base_ref: "main",
    layers: [
      { number: 1, head: "a", base: "main", mergeable_state: "clean" },
      { number: 2, head: "b", base: "a", mergeable_state: "clean" },
    ],
  }));
  assert.ok(stack);
  assert.equal(stack.trunk, "main");
  assert.equal(stack.layers[1]!.head, "b");
});

test("a merged bottom layer is carried through", async () => {
  const { stack } = await call(responder(200, {
    trunk: "main",
    pull_requests: [
      { number: 1, head: { ref: "a" }, base: { ref: "main" }, merged: true },
      { number: 2, head: { ref: "b" }, base: { ref: "a" }, mergeable_state: "clean" },
    ],
  }));
  assert.equal(stack!.layers[0]!.merged, true);
  assert.equal(stack!.layers[1]!.merged, undefined);
});
