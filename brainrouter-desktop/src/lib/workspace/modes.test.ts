/** DESK-MODES-1 — regression guards for the mode contract the shell presents. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACE_MODE_DEFINITIONS,
  WORKSPACE_MODE_IDS,
  describeModeTransition,
  modeForWorkspaceReference,
  workspaceModeDefinition,
} from './modes.js';

test('DESK-MODES-1: every switchable mode has one visible semantic definition', () => {
  assert.deepEqual(WORKSPACE_MODE_DEFINITIONS.map((definition) => definition.id), WORKSPACE_MODE_IDS);
  for (const mode of WORKSPACE_MODE_IDS) {
    const definition = workspaceModeDefinition(mode);
    assert.ok(definition.label.length > 0, `${mode} needs a label`);
    assert.ok(definition.scope.length > 0, `${mode} needs a scope`);
    assert.ok(definition.summary.length > 0, `${mode} needs an outcome`);
    assert.ok(definition.access.length > 0, `${mode} needs a capability statement`);
  }
});

test('DESK-MODES-1: every cross-mode reference target reaches its owning mode', () => {
  for (const mode of WORKSPACE_MODE_IDS) {
    assert.equal(modeForWorkspaceReference(mode), mode, `${mode} must be routable from a reference`);
  }
  assert.equal(modeForWorkspaceReference('unknown'), null);
});

test('DESK-MODES-1: Chat and Code state their access consequence without replacing the conversation', () => {
  const chat = describeModeTransition('code', 'chat');
  const code = describeModeTransition('chat', 'code');
  assert.equal(chat.changed, true);
  assert.match(chat.message, /conversation stays selected/i);
  assert.match(chat.message, /read-only/i);
  assert.match(code.message, /conversation stays selected/i);
  assert.match(code.message, /workspace tools/i);
});

test('DESK-MODES-1: selecting the current mode is a no-op', () => {
  const transition = describeModeTransition('planner', 'planner');
  assert.equal(transition.changed, false);
  assert.equal(transition.message, workspaceModeDefinition('planner').summary);
});
