/**
 * ADR-057 — the agent suggestion store: suggest_task records a bounded,
 * pending follow-up; the same title while still pending does not pile up;
 * start/dismiss flip status; only pending ones are offered as starters; the
 * store stays capped without evicting a pending item.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addAgentSuggestion, loadAgentSuggestions, pendingAgentSuggestions, setAgentSuggestionStatus } from '../triggers/suggestionStore.js';
import { withTempWorkspace } from './_helpers.js';

test('B-057 addAgentSuggestion records a bounded pending suggestion and dedupes by title while pending', () => {
  withTempWorkspace((ws) => {
    const a = addAgentSuggestion(ws, { title: '  Fix stale README badge  ', suggestedPrompt: 'Update the CI badge URL in README.md to the release/0.4.22 workflow.', reason: 'noticed the badge 404s', worktree: true }, 'sess-1');
    assert.equal(a.title, 'Fix stale README badge');
    assert.equal(a.status, 'pending'); assert.equal(a.worktree, true); assert.equal(a.createdBySessionKey, 'sess-1');
    assert.ok(a.id && a.createdAt > 0);
    const again = addAgentSuggestion(ws, { title: 'fix stale readme badge', suggestedPrompt: 'different text' }, 'sess-2');
    assert.equal(again.id, a.id, 'a pending duplicate title returns the existing record');
    assert.equal(pendingAgentSuggestions(ws).length, 1);
    assert.throws(() => addAgentSuggestion(ws, { title: '', suggestedPrompt: 'x' }), /title and prompt/);
    assert.throws(() => addAgentSuggestion(ws, { title: 'x', suggestedPrompt: '' }), /title and prompt/);
  });
});

test('B-057 start/dismiss flip status and drop out of the pending starters', () => {
  withTempWorkspace((ws) => {
    const a = addAgentSuggestion(ws, { title: 'Add retry-path coverage', suggestedPrompt: 'Add a test for the 5xx retry in llm.ts.' });
    const started = setAgentSuggestionStatus(ws, a.id, 'started', 'sess-new');
    assert.equal(started?.status, 'started'); assert.equal(started?.startedSessionKey, 'sess-new');
    assert.equal(pendingAgentSuggestions(ws).length, 0);
    assert.equal(loadAgentSuggestions(ws).length, 1, 'a started suggestion is kept, just not pending');
    // a resolved title no longer dedupes — the same follow-up can be raised again later
    const b = addAgentSuggestion(ws, { title: 'Add retry-path coverage', suggestedPrompt: 'again' });
    assert.notEqual(b.id, a.id);
    assert.equal(setAgentSuggestionStatus(ws, 'nope', 'dismissed'), null);
    const d = setAgentSuggestionStatus(ws, b.id, 'dismissed');
    assert.equal(d?.status, 'dismissed'); assert.equal(pendingAgentSuggestions(ws).length, 0);
  });
});

test('B-057 the store is capped and never evicts a pending suggestion', () => {
  withTempWorkspace((ws) => {
    for (let i = 0; i < 60; i++) { const s = addAgentSuggestion(ws, { title: `resolved ${i}`, suggestedPrompt: 'x' }); setAgentSuggestionStatus(ws, s.id, 'dismissed'); }
    const pending = addAgentSuggestion(ws, { title: 'still pending', suggestedPrompt: 'keep me' });
    for (let i = 0; i < 60; i++) { const s = addAgentSuggestion(ws, { title: `more ${i}`, suggestedPrompt: 'x' }); setAgentSuggestionStatus(ws, s.id, 'dismissed'); }
    const all = loadAgentSuggestions(ws);
    assert.ok(all.length <= 50, `capped, got ${all.length}`);
    assert.ok(all.some((s) => s.id === pending.id), 'the pending suggestion survived the cap');
  });
});
