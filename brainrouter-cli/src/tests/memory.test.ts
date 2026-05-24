import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildMemoryBriefing, selectCitedRecordIds } from '../memory/briefing.js';
import { clampPayload, extractMemories, renderMemoryCards } from '../memory/formatters.js';
import { expandMentions } from '../memory/mentions.js';
import { initAgentMd } from '../prompt/initAgentMd.js';
import { withTempWorkspace, withTempWorkspaceAsync } from './_helpers.js';

test('buildMemoryBriefing merges parallel memory sources into one block with redacted secrets', async () => {
  const calls: string[] = [];
  const stubClient: any = {
    callTool: async (name: string) => {
      calls.push(name);
      if (name === 'memory_recall') {
        return {
          content: [{
            text: JSON.stringify({
              // Canonical MCP key as emitted by recall.ts. The CLI previously
              // looked for `recalledCognitiveRecords` (typo) which made every
              // briefing return 0 records. The dedicated regression test
              // below covers the canonical-key-only path.
              recalledCognitiveMemories: [
                { recordId: 'rec_a', content: 'BrainRouter uses sqlite for memory storage and runs hybrid recall.', type: 'codebase_fact' },
                { recordId: 'rec_b', content: 'The CLI lives in brainrouter/src.', type: 'codebase_fact' },
              ],
            }),
          }],
        };
      }
      if (name === 'memory_working_context') {
        return { content: [{ text: 'API key sk-secretvalue123 should never leak.' }] };
      }
      if (name === 'memory_task_state') {
        return { content: [{ text: 'No open tasks.' }] };
      }
      return { isError: true };
    },
  };
  const briefing = await buildMemoryBriefing({
    mcpClient: stubClient,
    mcpTools: [{ name: 'memory_recall' }, { name: 'memory_working_context' }, { name: 'memory_task_state' }],
    sessionKey: 'session:x',
    workspaceRoot: '/tmp/example',
    query: 'how do we store memory?',
  });

  assert.deepEqual(briefing.sourcesQueried.sort(), ['memory_recall', 'memory_task_state', 'memory_working_context']);
  assert.deepEqual(briefing.recalledRecordIds.sort(), ['rec_a', 'rec_b']);
  assert.match(briefing.block, /BrainRouter Memory Briefing/);
  assert.match(briefing.block, /Recalled cognitive memories/);
  assert.match(briefing.block, /sqlite/);
  assert.doesNotMatch(briefing.block, /sk-secretvalue123/);
  assert.match(briefing.block, /\[REDACTED\]/);
});

test('buildMemoryBriefing extracts records from the canonical recalledCognitiveMemories key', async () => {
  // Tight regression test for the typo fix: previously the CLI looked for
  // `recalledCognitiveRecords` which the MCP never emitted, so every briefing
  // silently returned 0 records. Asserting against ONLY the canonical key
  // ensures we don't regress to the old fallback-driven behavior.
  const stubClient: any = {
    callTool: async (name: string) => {
      if (name === 'memory_recall') {
        return {
          content: [{
            text: JSON.stringify({
              recalledCognitiveMemories: [
                { recordId: 'mem_only_1', content: 'Canonical-key record one.', type: 'codebase_fact' },
                { recordId: 'mem_only_2', content: 'Canonical-key record two.', type: 'instruction' },
              ],
            }),
          }],
        };
      }
      return { isError: true };
    },
  };
  const briefing = await buildMemoryBriefing({
    mcpClient: stubClient,
    mcpTools: [{ name: 'memory_recall' }],
    sessionKey: 'session:canonical',
    workspaceRoot: '/tmp/example',
    query: 'verify canonical key',
  });
  assert.deepEqual(briefing.recalledRecordIds.sort(), ['mem_only_1', 'mem_only_2']);
});

test('selectCitedRecordIds picks records whose ID or distinctive snippet appears in the final answer', () => {
  const recalled = [
    { recordId: 'rec_a', content: 'BrainRouter uses sqlite for memory storage and runs hybrid recall.' },
    { recordId: 'rec_b', content: 'Unrelated note about coffee preferences.' },
    { recordId: 'rec_c', content: 'short' },
  ];
  const answer = 'We answer with: BrainRouter uses sqlite for memory storage and runs hybrid recall. We also mention rec_c by id.';
  const cited = selectCitedRecordIds(recalled, answer).sort();
  assert.deepEqual(cited, ['rec_a', 'rec_c']);
});

test('initAgentMd creates AGENT.md when missing and is idempotent', () => {
  withTempWorkspace((workspace) => {
    const first = initAgentMd(workspace);
    assert.equal(first.status, 'created');
    assert.equal(fs.existsSync(path.join(workspace, 'AGENT.md')), true);
    const second = initAgentMd(workspace);
    assert.equal(second.status, 'exists');
  });
});

test('initAgentMd respects pre-existing AGENTS.md', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# existing\n');
    const result = initAgentMd(workspace);
    assert.equal(result.status, 'exists');
    assert.equal(fs.existsSync(path.join(workspace, 'AGENT.md')), false);
  });
});

test('initAgentMd populates AGENT.md from repo signals when package.json present', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'demo',
      scripts: { build: 'tsc', test: 'vitest run', dev: 'tsx src/index.ts' },
    }));
    fs.writeFileSync(path.join(workspace, 'tsconfig.json'), '{}');
    const result = initAgentMd(workspace);
    assert.equal(result.status, 'created');
    const body = fs.readFileSync(result.path, 'utf8');
    assert.match(body, /Detected project signals/);
    assert.match(body, /Node\.js/);
    assert.match(body, /TypeScript/);
    assert.match(body, /npm run build/);
    assert.match(body, /npm test/);
  });
});

test('initAgentMd falls back to bare template when no signals detected', () => {
  withTempWorkspace((workspace) => {
    const result = initAgentMd(workspace);
    assert.equal(result.status, 'created');
    const body = fs.readFileSync(result.path, 'utf8');
    // Fallback template doesn't carry the "Detected project signals" block.
    assert.doesNotMatch(body, /Detected project signals/);
    assert.match(body, /AGENT\.md/);
  });
});

test('expandMentions inlines workspace files and skips outside-of-workspace paths', () => {
  withTempWorkspace((workspace) => {
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const x = 1;\n');
    const { expanded, mentions } = expandMentions('Please review @src/index.ts plus @../../../etc/passwd', workspace);
    // Only the safe in-workspace file got attached; the escape attempt was skipped.
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].token, 'src/index.ts');
    assert.match(expanded, /Attached files/);
    assert.match(expanded, /export const x = 1;/);
    // No fenced reference header was created for the dangerous mention.
    assert.doesNotMatch(expanded, /referenced via @\.\.\//);
  });
});

test('expandMentions truncates oversize files and marks them', () => {
  withTempWorkspace((workspace) => {
    const big = 'x'.repeat(30_000);
    fs.writeFileSync(path.join(workspace, 'big.txt'), big);
    const { expanded, mentions } = expandMentions('see @big.txt', workspace, 1000);
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].truncated, true);
    assert.match(expanded, /truncated at 1000 chars/);
  });
});

test('expandMentions deduplicates repeated mentions of the same file', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync(path.join(workspace, 'README.md'), '# hello\n');
    const { mentions, expanded } = expandMentions('see @README.md and again @README.md', workspace);
    assert.equal(mentions.length, 1);
    const headerOccurrences = expanded.split('### README.md').length - 1;
    assert.equal(headerOccurrences, 1);
  });
});

test('memoryFormatters: extractMemories parses both direct arrays and prependContext XML', () => {
  const direct = extractMemories({
    recalledCognitiveRecords: [
      { recordId: 'rec_a', type: 'codebase_fact', content: 'A is true', sceneName: 'scene-x' },
      { record_id: 'rec_b', type: 'instruction', content: 'Always do B' }, // snake_case key
    ],
  });
  assert.equal(direct.length, 2);
  assert.equal(direct[0].recordId, 'rec_a');
  assert.equal(direct[1].recordId, 'rec_b');

  const fallback = extractMemories({
    prependContext: `<relevant-memories>
  - [codebase_fact|scene-y] The CLI uses sqlite. (skill: storage)
  - [instruction|scene-z] Prefer Zod over Yup. (skill: validation)
</relevant-memories>`,
  });
  assert.equal(fallback.length, 2);
  assert.equal(fallback[0].type, 'codebase_fact');
  assert.match(fallback[0].content, /sqlite/);
  // synthetic recordIds for the inline path
  assert.match(fallback[0].recordId, /^inline-/);
});

test('memoryFormatters: renderMemoryCards limits and respects empty state', () => {
  const empty = renderMemoryCards([], 'Recall');
  assert.match(empty, /no records returned/);

  const many = Array.from({ length: 15 }, (_, i) => ({
    recordId: `rec_${i}`,
    type: 'fact',
    content: `fact #${i}`,
  }));
  const rendered = renderMemoryCards(many, 'Recall', 5);
  assert.match(rendered, /Recall/);
  assert.match(rendered, /…and 10 more/);
});

test('memoryFormatters: clampPayload truncates with marker', () => {
  const big = 'x'.repeat(10_000);
  const clamped = clampPayload(big, 1000);
  assert.equal(clamped.length <= 1000 + 80, true);
  assert.match(clamped, /9000 chars truncated/);
});

test('memoryConsolidation: writes per-type files and MEMORY.md index', async () => {
  const { consolidateMemories, memoriesDir } = await import('../memory/consolidation.js');
  await withTempWorkspaceAsync(async (workspace) => {
    const stubMcp: any = {
      listTools: async () => ({ tools: [] }),
      callTool: async (name: string) => {
        if (name !== 'memory_search') throw new Error(`unexpected ${name}`);
        return {
          content: [{
            text: JSON.stringify({
              records: [
                { recordId: 'rec_user_1', type: 'user', content: 'User is a senior Go engineer learning React.' },
                { recordId: 'rec_fb_1', type: 'feedback', content: 'Always run integration tests against real DB.' },
                { recordId: 'rec_proj_1', type: 'project', content: 'Freeze starts 2026-03-05; mobile release branch is cut.' },
                { recordId: 'rec_ref_1', type: 'reference', content: 'Linear project INGEST tracks pipeline bugs.' },
                { recordId: 'rec_misc_1', type: 'codebase_fact', content: 'Misc memory should land in raw_memories.md.' },
              ],
            }),
          }],
        };
      },
      close: async () => {},
    };
    const result = await consolidateMemories(stubMcp, workspace);
    assert.equal(result.totalRecords, 5);
    assert.equal(result.perType.user, 1);
    assert.equal(result.perType.feedback, 1);
    assert.equal(result.perType.project, 1);
    assert.equal(result.perType.reference, 1);
    assert.equal(result.perType.raw, 1);
    const dir = memoriesDir(workspace);
    assert.match(fs.readFileSync(path.join(dir, 'user.md'), 'utf8'), /senior Go engineer/);
    assert.match(fs.readFileSync(path.join(dir, 'feedback.md'), 'utf8'), /integration tests/);
    assert.match(fs.readFileSync(path.join(dir, 'project.md'), 'utf8'), /Freeze starts/);
    assert.match(fs.readFileSync(path.join(dir, 'reference.md'), 'utf8'), /Linear project INGEST/);
    assert.match(fs.readFileSync(path.join(dir, 'raw_memories.md'), 'utf8'), /raw_memories\.md/);
    assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /5 consolidated memory records/);
  });
});
