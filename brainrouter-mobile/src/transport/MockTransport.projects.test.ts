// Verifies the MockTransport supports the Projects feature: a created project
// appears in recents, starts empty, and a New chat shows up in THAT project after
// its first turn (so the demo is exercisable without a live host).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockTransport } from './MockTransport.js';

test('openWorkspace adds a fresh project to recents and it starts empty', async () => {
  const t = new MockTransport();
  await t.trustWorkspace('/proj/demo-app');
  const opened = await t.openWorkspace('/proj/demo-app');
  assert.equal(opened.opened, true);

  const recents = await t.workspaceRecents();
  assert.ok(recents.recents.includes('/proj/demo-app'), 'new project is in recents');
  assert.equal(recents.current, '/proj/demo-app', 'it becomes the current project');

  const ws = await t.workspaceSessions('/proj/demo-app');
  assert.equal(ws.rows.length, 0, 'a brand-new project has no chats yet');
});

test('a New chat shows up in its project after the first turn', async () => {
  const t = new MockTransport();
  await t.trustWorkspace('/proj/demo-app');
  await t.openWorkspace('/proj/demo-app');

  // What the app does: open a fresh session, then send the first message.
  t.send({ kind: 'resume-session', sessionKey: 'mobile:newchat-1' });
  t.send({ kind: 'start-turn', prompt: 'wire up the projects feature' });

  const ws = await t.workspaceSessions('/proj/demo-app');
  const row = ws.rows.find((s) => s.sessionKey === 'mobile:newchat-1');
  assert.ok(row, 'the new chat is listed under its project');
  assert.equal(row?.firstUserMessage, 'wire up the projects feature', 'titled by the first message');
});

test('chats stay scoped to their own project', async () => {
  const t = new MockTransport();
  for (const root of ['/proj/a', '/proj/b']) {
    await t.trustWorkspace(root);
    await t.openWorkspace(root);
    t.send({ kind: 'resume-session', sessionKey: `chat-in-${root}` });
    t.send({ kind: 'start-turn', prompt: `hello ${root}` });
  }
  const a = await t.workspaceSessions('/proj/a');
  const b = await t.workspaceSessions('/proj/b');
  assert.ok(a.rows.some((s) => s.sessionKey === 'chat-in-/proj/a'));
  assert.ok(!a.rows.some((s) => s.sessionKey === 'chat-in-/proj/b'), 'project A does not leak project B chats');
  assert.ok(b.rows.some((s) => s.sessionKey === 'chat-in-/proj/b'));
});
