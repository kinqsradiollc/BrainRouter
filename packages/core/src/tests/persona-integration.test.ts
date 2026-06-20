import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryBriefing } from '../memory/briefing.js';
import { hashBriefingContent, decideAnchorAction } from '../memory/anchorPin.js';

/**
 * §4.8 ship-gate integration test: a populated brain produces a briefing
 * that renders the `### Core Identity` section AND whose prefix hash is
 * stable across two no-op turns. The stability claim is what makes the
 * persona anchor zero-cost after turn 1 — if the hash drifted on every
 * recall, the provider prefix cache would miss and we'd pay the persona
 * tokens repeatedly.
 *
 * "No-op" here means: same persona body, same recall hits. Recall content
 * is what drifts in practice across real turns; persona only drifts when
 * the brain re-distills, which is rare. This test isolates the persona
 * stability invariant by holding recall fixed too.
 */

function makeStubClient(canned: Record<string, any>) {
  return {
    async callTool(name: string, _args: Record<string, unknown>) {
      const payload = canned[name];
      if (payload === undefined) {
        return { isError: true, content: [{ type: 'text', text: 'tool not configured' }] };
      }
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return { isError: false, content: [{ type: 'text', text }] };
    },
  } as any;
}

test('persona integration: briefing renders Core Identity section against a populated brain', async () => {
  const briefing = await buildMemoryBriefing({
    mcpClient: makeStubClient({
      memory_persona: {
        personaMd: '# Anh\nSenior engineer, terse responses, focused on memory pipelines.',
        hash: '1234567890abcdef',
        cognitiveCountAtGeneration: 18,
        updatedTime: '2026-05-28T00:00:00Z',
      },
      memory_recall: {
        recalledCognitiveMemories: [{ recordId: 'rec-1', content: 'prior turn note' }],
      },
    }),
    mcpTools: [{ name: 'memory_persona' }, { name: 'memory_recall' }],
    sessionKey: 'integration-sk',
    workspaceRoot: '/tmp/integration-ws',
    query: 'start this task',
  });
  assert.match(briefing.block, /### Core Identity \(hash 1234567890abcdef · 18 cognitives\)/);
  assert.match(briefing.block, /Senior engineer, terse responses/);
  assert.ok(briefing.sourcesQueried.includes('memory_persona'));
});

test('persona integration: prefix hash is stable across two consecutive no-op turns', async () => {
  // Same canned payloads on both turns — mirrors the cache-stable contract.
  const canned = {
    memory_persona: {
      personaMd: '# Anh\nSenior engineer; prefers terse responses.',
      hash: 'stable-hash-bytes',
      cognitiveCountAtGeneration: 12,
    },
    memory_recall: {
      recalledCognitiveMemories: [{ recordId: 'rec-stable', content: 'same context' }],
    },
  };
  const args = {
    mcpClient: makeStubClient(canned),
    mcpTools: [{ name: 'memory_persona' }, { name: 'memory_recall' }],
    sessionKey: 'integration-sk',
    workspaceRoot: '/tmp/integration-ws',
    query: 'continue from the previous issue',
  };

  const turn1 = await buildMemoryBriefing(args);
  const turn2 = await buildMemoryBriefing(args);

  const h1 = hashBriefingContent(turn1.block);
  const h2 = hashBriefingContent(turn2.block);
  assert.equal(h1, h2, `expected stable hash across no-op turns, got ${h1} vs ${h2}`);

  // And `decideAnchorAction` reports `STABLE` — the second turn must NOT
  // touch the immutable prefix.
  const decision = decideAnchorAction({
    newContentHash: h2,
    pinnedHash: h1,
    envSetting: undefined,
  });
  assert.equal(decision.action, 'STABLE');
  assert.equal(decision.nextPinnedHash, h1);
});

test('persona integration: persona content change forces a re-anchor (APPEND)', async () => {
  const args = (personaBody: string) => ({
    mcpClient: makeStubClient({
      memory_persona: {
        personaMd: personaBody,
        hash: 'h-for-' + personaBody.length,
        cognitiveCountAtGeneration: 5,
      },
      memory_recall: {
        recalledCognitiveMemories: [{ recordId: 'rec-stable', content: 'same context' }],
      },
    }),
    mcpTools: [{ name: 'memory_persona' }, { name: 'memory_recall' }],
    sessionKey: 'integration-sk',
    workspaceRoot: '/tmp/integration-ws',
    query: 'continue from the previous issue',
  });

  const turn1 = await buildMemoryBriefing(args('# Anh v1\nshort.'));
  const turn2 = await buildMemoryBriefing(args('# Anh v2\nthe persona has been re-distilled.'));

  const h1 = hashBriefingContent(turn1.block);
  const h2 = hashBriefingContent(turn2.block);
  assert.notEqual(h1, h2, 'persona body change must change the prefix hash');

  const decision = decideAnchorAction({
    newContentHash: h2,
    pinnedHash: h1,
    envSetting: undefined,
  });
  // APPEND — the existing pin stays, the fresh briefing is appended to
  // the log. Operators reset the anchor via /refresh-memory or
  // /persona refresh (the latter calls clearPinnedMemoryAnchor).
  assert.equal(decision.action, 'APPEND');
});
