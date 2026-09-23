/**
 * ADR-049 — StudyView smoke test. The view is a thin client over `study:*`
 * queries (all logic is the tested core); this proves the React tree mounts and
 * renders the deck list against a stubbed host bridge, so a broken hook or query
 * name fails here rather than only in the running app.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { StudyView } from './StudyView.js';
import { mount, screenText, hasButton, type Mounted } from '../testing/reactHarness.js';

/** A fake `window.brainrouter` that answers each `study:*` query from `answers`. */
function installBridge(answers: Record<string, unknown>): () => void {
  const listeners = new Set<(msg: unknown) => void>();
  const w = globalThis as unknown as { window?: Record<string, unknown> };
  w.window = w.window ?? {};
  const prev = w.window.brainrouter;
  w.window.brainrouter = {
    onEvent: (fn: (msg: unknown) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    send: (msg: { kind: string; id: string; name: string }) => {
      if (msg.kind !== 'query') return;
      const result = answers[msg.name] ?? {};
      queueMicrotask(() => {
        for (const fn of listeners) fn({ event: { kind: 'query-result', id: msg.id, ok: true, result } });
      });
    },
  };
  return () => { w.window!.brainrouter = prev; };
}

test('StudyView renders the empty state when the workspace has no decks', async () => {
  const restore = installBridge({ 'study:list': { decks: [], streak: 0, user: 'local' } });
  let m: Mounted | null = null;
  try {
    m = await mount(<StudyView />);
    await m.flush();
    assert.match(screenText(m.root), /No decks yet/);
    assert.ok(hasButton(m.root, 'Create your first deck'));
  } finally {
    m?.unmount();
    restore();
  }
});

test('StudyView lists decks with due/new chips + streak', async () => {
  const restore = installBridge({
    'study:list': {
      streak: 3, user: 'local',
      decks: [{
        id: 'rust', name: 'Rust', description: 'ownership etc', tags: ['rust'], updatedAt: 'x',
        stats: { deckId: 'rust', totalCards: 12, newCards: 4, learningCards: 1, reviewCards: 6, dueCards: 3, retention: 0.75 },
      }],
    },
  });
  let m: Mounted | null = null;
  try {
    m = await mount(<StudyView />);
    await m.flush();
    const text = screenText(m.root);
    assert.match(text, /Rust/);
    assert.match(text, /3 due/);
    assert.match(text, /4 new/);
    assert.match(text, /3-day streak/);
  } finally {
    m?.unmount();
    restore();
  }
});
