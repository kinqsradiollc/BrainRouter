import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStories, buildStoryPrompt } from './generate.js';

const uiMap = {
  version: 1 as const,
  generatedAt: '2020-01-01T00:00:00.000Z',
  screens: [
    {
      id: 'login',
      title: 'Login',
      platform: 'web' as const,
      route: '/login',
      elements: [
        { id: 'email-field', testID: 'email-field', type: 'input' as const, action: 'type' as const },
        { id: 'login-submit', testID: 'login-submit', type: 'button' as const, action: 'tap' as const },
        { id: 'login-message', testID: 'login-message', type: 'element' as const, action: 'assertVisible' as const },
      ],
    },
  ],
};

test('validateStories keeps valid steps and drops unknown targets', () => {
  const raw = {
    stories: [
      {
        title: 'Log in',
        description: 'Sign in.',
        steps: [
          { action: 'navigate', target: 'login' },
          { action: 'type', target: 'email-field', text: 'a@b.co' },
          { action: 'tap', target: 'ghost-button' }, // unknown → dropped
          { action: 'tap', target: 'login-submit' },
          { action: 'assertVisible', target: 'login-message' },
        ],
      },
    ],
  };
  const stories = validateStories(raw, uiMap);
  assert.equal(stories.length, 1);
  assert.equal(stories[0].id, 'log-in');
  assert.deepEqual(stories[0].steps.map((s) => s.target), ['login', 'email-field', 'login-submit', 'login-message']);
});

test('validateStories rejects thin (<2-step) and untitled stories', () => {
  const raw = {
    stories: [
      { title: 'Thin', description: '', steps: [{ action: 'navigate', target: 'login' }] },
      { title: '', description: '', steps: [{ action: 'navigate', target: 'login' }, { action: 'tap', target: 'login-submit' }] },
    ],
  };
  assert.equal(validateStories(raw, uiMap).length, 0);
});

test('validateStories dedupes ids and tolerates a JSON string', () => {
  const raw = JSON.stringify({
    stories: [
      { title: 'Go', description: '', steps: [{ action: 'navigate', target: 'login' }, { action: 'tap', target: 'login-submit' }] },
      { title: 'Go', description: '', steps: [{ action: 'navigate', target: 'login' }, { action: 'tap', target: 'login-submit' }] },
    ],
  });
  assert.deepEqual(validateStories(raw, uiMap).map((x) => x.id), ['go', 'go-2']);
});

test('validateStories defaults type text and coerces a missing description', () => {
  const raw = { stories: [{ title: 'X', steps: [{ action: 'navigate', target: 'login' }, { action: 'type', target: 'email-field' }] }] };
  const s = validateStories(raw, uiMap);
  assert.equal(s[0].description, '');
  assert.equal((s[0].steps[1] as { text: string }).text, 'test');
});

test('buildStoryPrompt embeds screen ids + testIDs and the tool name', () => {
  const p = buildStoryPrompt(uiMap);
  assert.match(p.user, /login/);
  assert.match(p.user, /login-submit/);
  assert.equal(p.toolName, 'propose_stories');
});
