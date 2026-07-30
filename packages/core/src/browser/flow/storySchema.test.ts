import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorySchema, parseStoryYaml, serializeStoryYaml, parseStoriesJson } from './storySchema.js';

const story = {
  id: 'log-in-and-add-a-todo',
  title: 'Log in and add a todo',
  description: 'Sign in, then create a todo item.',
  steps: [
    { action: 'navigate' as const, target: 'login' },
    { action: 'type' as const, target: 'email-field', text: 'a@b.co' },
    { action: 'tap' as const, target: 'login-submit' },
    { action: 'assertVisible' as const, target: 'login-message' },
  ],
};

test('StorySchema accepts a valid story', () => {
  const s = StorySchema.parse(story);
  assert.equal(s.steps.length, 4);
  assert.equal(s.title, 'Log in and add a todo');
});

test('serialize → parse round-trips a story', () => {
  const back = parseStoryYaml(serializeStoryYaml(story));
  assert.deepEqual(back, story);
});

test('StorySchema rejects a missing title and an invalid step', () => {
  assert.throws(() => StorySchema.parse({ id: 'x', description: 'd', steps: [] }));
  assert.throws(() => StorySchema.parse({ ...story, steps: [{ action: 'bogus', target: 'x' }] }));
});

test('a type step still requires its text', () => {
  assert.throws(() => StorySchema.parse({ ...story, steps: [{ action: 'type', target: 'email' }] }));
});

test('parseStoriesJson reads a manifest, a bare array, and skips invalid', () => {
  const good = { id: 'x', title: 'X', description: 'd', steps: [
    { action: 'navigate' as const, target: 'home' },
    { action: 'tap' as const, target: 'b' },
  ] };
  const bad = { id: 'y', title: 'Y' }; // missing description + steps
  assert.equal(parseStoriesJson(JSON.stringify({ stories: [good, bad] })).length, 1);
  assert.equal(parseStoriesJson(JSON.stringify([good])).length, 1);
  assert.equal(parseStoriesJson('not json at all').length, 0);
  assert.equal(parseStoriesJson(JSON.stringify({})).length, 0);
  const one = parseStoriesJson(JSON.stringify({ stories: [good] }));
  assert.equal(one[0].id, 'x');
});
