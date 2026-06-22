import test from 'node:test';
import assert from 'node:assert/strict';

import { makeAgent, withTempWorkspace } from './_helpers.js';

/**
 * WS0 (integration) — lock in the audit conclusion at the real agent injection
 * path, not just the pure helpers.
 *
 * The audit found that the prompt assembly is ALREADY ordered for prefix-cache
 * stability: the per-turn-volatile content (goal-anchor, memory briefing,
 * fan-out hints) is *appended* via `replaceTaggedSystemMessage` — never pinned,
 * never at position 0 — so it lands in the append region and does NOT enter the
 * cache-stable prefix. These tests prove that invariant holds through the actual
 * agent methods, so a future change that accidentally pins or front-loads
 * volatile content (busting the provider prefix cache) trips a red test.
 */

// makeAgent(silent) skips bootstrap, so seed chatHistory[0] with a real system
// message the way a resumed session does — loadHistory prepends createSystemMessage().
const seed = (agent: ReturnType<typeof makeAgent>): void => {
  agent.loadHistory([
    { role: 'user', content: 'previous question' },
    { role: 'assistant', content: 'previous answer' },
  ]);
};

test('WS0: appended goal-anchor + briefing do NOT change the cache-stable prefix', () => {
  withTempWorkspace((ws) => {
    const agent = makeAgent(ws);
    seed(agent);
    const before = agent.getPrefixComponents();
    assert.notEqual(before.systemHash, 'e3b0c44298fc1c14', 'sanity: a real system message is present (not the empty-string hash)');

    // Exactly what runTurn appends each turn (tagged system messages).
    agent.replaceTaggedSystemMessage('goal-anchor', 'GOAL: ship WS0 · budget 5 turns');
    agent.replaceTaggedSystemMessage('memory-briefing', 'RECALL: 6 records · pinnedAnchor v3');

    const after = agent.getPrefixComponents();
    assert.equal(after.systemHash, before.systemHash, 'position-0 system prompt unchanged by appended directives');
    assert.equal(after.anchorsHash, before.anchorsHash, 'no pinned-anchor churn (the directives are not pinned)');
    assert.equal(after.anchorCount, before.anchorCount, 'directives do not register as pinned anchors');
  });
});

test('WS0: churning the volatile content turn-over-turn still never reaches the prefix', () => {
  withTempWorkspace((ws) => {
    const agent = makeAgent(ws);
    seed(agent);
    const before = agent.getPrefixComponents();

    // Simulate several turns of changing goal status + fresh recall — the kind
    // of churn that WOULD bust a provider prefix cache if it were front-loaded.
    for (let turn = 1; turn <= 4; turn++) {
      agent.replaceTaggedSystemMessage('goal-anchor', `GOAL: ship WS0 · budget ${5 - turn} turns${turn === 4 ? ' · FINAL' : ''}`);
      agent.replaceTaggedSystemMessage('memory-briefing', `RECALL: ${5 + turn} records · pinnedAnchor v${turn}`);
      const now = agent.getPrefixComponents();
      assert.equal(now.systemHash, before.systemHash, `turn ${turn}: prefix system slot still byte-stable`);
      assert.equal(now.anchorsHash, before.anchorsHash, `turn ${turn}: pinned-anchor slot still byte-stable`);
    }
  });
});

test('WS0: retracting a tagged directive also leaves the prefix untouched', () => {
  withTempWorkspace((ws) => {
    const agent = makeAgent(ws);
    seed(agent);
    const before = agent.getPrefixComponents();
    agent.replaceTaggedSystemMessage('goal-anchor', 'GOAL: temporary');
    agent.removeTaggedSystemMessage('goal-anchor'); // e.g. goal cleared mid-session
    const after = agent.getPrefixComponents();
    assert.equal(after.systemHash, before.systemHash);
    assert.equal(after.anchorsHash, before.anchorsHash);
  });
});
