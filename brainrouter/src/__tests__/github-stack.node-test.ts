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
  assert.match(result.reason!, /could not be read/);
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

test("the free stacked hint reads the pull request payload we already fetch", async () => {
  // Calling the Stacks API on every review would add a round-trip per review to
  // be told "no" for the large majority of pull requests, which are unstacked.
  // The PR payload already carries a `stack` object when it is in one.
  const { pullRequestIsStacked } = await import("../integrations/githubStack.js");
  assert.equal(pullRequestIsStacked({ stack: { number: 4, size: 3, position: 2 } }), true);
  assert.equal(pullRequestIsStacked({}), false);
  assert.equal(pullRequestIsStacked(null), false);
  assert.equal(pullRequestIsStacked(undefined), false);
  assert.equal(pullRequestIsStacked({ stack: null }), false);
});

test("a stack of one is not treated as a stack", async () => {
  // GitHub can report a degenerate single-layer stack. Rendering a "layer 1 of
  // 1" banner on an ordinary pull request is noise, and noise is what makes
  // people stop reading the comment that also carries the findings.
  const { pullRequestIsStacked } = await import("../integrations/githubStack.js");
  assert.equal(pullRequestIsStacked({ stack: { size: 1 } }), false);
  assert.equal(pullRequestIsStacked({ stack: { size: 2 } }), true);
});

test("an unparseable size still counts as stacked rather than silently hiding it", async () => {
  // Erring toward showing the banner: a missing size is an API-shape question,
  // not evidence that the stack is not real.
  const { pullRequestIsStacked } = await import("../integrations/githubStack.js");
  assert.equal(pullRequestIsStacked({ stack: { number: 4 } }), true);
});

test("a null or non-object layer entry degrades instead of throwing", async () => {
  // Found by the security review on #1298, and it was the sharpest kind of
  // finding: the crash escaped fetchPullRequestStack, aborted runPrReview, and
  // stopped the SECURITY COMMENT ITSELF from being posted. A stack banner must
  // never be able to suppress the findings it sits next to.
  //
  // The earlier tests covered `"nope"` and `[]` but not `[null]` — the gap in
  // the test was the gap in the code.
  for (const bad of [[null], [undefined], ["a string"], [42], [{ number: 1, head: "a", base: "main" }, null]]) {
    const result = await call(responder(200, { trunk: "main", pull_requests: bad }));
    assert.equal(result.stack, null, `for ${JSON.stringify(bad)}`);
    assert.ok(result.reason, "a reason is always given");
  }
});

test("a payload that throws while being read degrades rather than escaping", async () => {
  // Defence in depth for shapes nobody predicted: the whole parse is wrapped,
  // so any future preview-era surprise still cannot abort the review.
  const hostile = {
    trunk: "main",
    get pull_requests() { throw new Error("exploding getter"); },
  };
  const result = await call(responder(200, hostile));
  assert.equal(result.stack, null);
  assert.ok(result.reason);
});
