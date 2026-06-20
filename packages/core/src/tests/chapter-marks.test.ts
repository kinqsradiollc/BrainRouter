import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { chapterEntryContent, listChapters, formatChapters } from '../session/chapterMarks.js';
import { loadTranscript } from '../session/sessionStore.js';
import { withTempWorkspaceAsync } from './_helpers.js';
import type { TranscriptEntry } from '../session/sessionStore.js';

test('listChapters/formatChapters: extracts tagged markers, skips malformed', () => {
  const entries: TranscriptEntry[] = [
    { role: 'user', content: 'go', timestamp: '2026-06-10T05:00:00.000Z' },
    { role: 'system', name: 'chapter', content: chapterEntryContent('Exploration'), timestamp: '2026-06-10T05:01:00.000Z' },
    { role: 'assistant', content: 'looking', timestamp: '2026-06-10T05:02:00.000Z' },
    { role: 'system', name: 'chapter', content: chapterEntryContent('Bug fix', 'patched recall'), timestamp: '2026-06-10T05:10:00.000Z' },
    { role: 'system', name: 'chapter', content: 'not-json{', timestamp: '2026-06-10T05:11:00.000Z' },
    { role: 'system', name: 'other', content: chapterEntryContent('decoy'), timestamp: '2026-06-10T05:12:00.000Z' },
  ];
  const marks = listChapters(entries);
  assert.deepEqual(marks.map((m) => [m.index, m.title]), [[1, 'Exploration'], [3, 'Bug fix']]);
  const lines = formatChapters(marks);
  assert.match(lines[0], /^ {2}1\. \[#1\] Exploration · 05:01:00$/);
  assert.match(lines[1], /2\. \[#3\] Bug fix · 05:10:00 — patched recall/);
  assert.deepEqual(formatChapters([]), ['No chapters marked in this session yet.']);
});

test('mark_chapter tool: validates + persists to the session transcript', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: true,
    });
    const runTool = (name: string, args: any): Promise<string> =>
      (agent as any).executeLocalTool(name, args, [], new Map());

    await assert.rejects(() => runTool('mark_chapter', { title: '' }), /non-empty title/);
    await assert.rejects(() => runTool('mark_chapter', { title: 'x'.repeat(70) }), /under 60 chars/);

    const ok = JSON.parse(await runTool('mark_chapter', { title: 'Verification', summary: 'tests + CI' }));
    assert.equal(ok.marked, true);

    const marks = listChapters(loadTranscript(workspace, agent.sessionKey));
    assert.equal(marks.length, 1);
    assert.equal(marks[0].title, 'Verification');
    assert.equal(marks[0].summary, 'tests + CI');
  });
});
