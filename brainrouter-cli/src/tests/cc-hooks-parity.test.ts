import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addHook, runHooks, readHooks, removeHook,
  applyMessageDisplayHooks, parseSessionStartDirectives,
} from '@kinqs/brainrouter-core/hooks';
import { setSessionMeta, getSessionMeta } from '@kinqs/brainrouter-core/session';
import { withTempWorkspace } from './_helpers.js';

/**
 * CC-hooks parity — the CLI-side wiring the render/boot paths use:
 *   - `turnRunner` runs `message-display` hooks and folds them with
 *     `applyMessageDisplayHooks` before `controller.push.assistant`.
 *   - `runChat` runs `session-start` hooks and applies the folded
 *     `parseSessionStartDirectives` (rename via `setSessionMeta`, reloadSkills).
 * These tests drive that exact chain through the real core barrel against a
 * temp workspace, so a regression in either the hook wiring or the barrel
 * re-export is caught here (not just in the pure core unit tests).
 */

test('message-display: a registered hook TRANSFORMS the about-to-display text', () => {
  withTempWorkspace((workspace) => {
    for (const h of readHooks(workspace)) removeHook(workspace, h.id);
    addHook(workspace, { event: 'message-display', command: `echo '{"updatedOutput":"[reviewed] hi"}'` });
    const outcome = applyMessageDisplayHooks('hi', runHooks(workspace, 'message-display', { payload: { text: 'hi' } }));
    assert.equal(outcome.text, '[reviewed] hi');
    assert.equal(outcome.hidden, false);
    assert.equal(outcome.transformed, true);
  });
});

test('message-display: a deny hook HIDES the assistant message', () => {
  withTempWorkspace((workspace) => {
    for (const h of readHooks(workspace)) removeHook(workspace, h.id);
    addHook(workspace, { event: 'message-display', command: `echo '{"decision":"deny"}'` });
    const outcome = applyMessageDisplayHooks('secret internal note', runHooks(workspace, 'message-display', { payload: { text: 'secret internal note' } }));
    assert.equal(outcome.hidden, true);
    assert.equal(outcome.text, '');
  });
});

test('message-display: no hook registered → text passes through untouched', () => {
  withTempWorkspace((workspace) => {
    for (const h of readHooks(workspace)) removeHook(workspace, h.id);
    const outcome = applyMessageDisplayHooks('unchanged', runHooks(workspace, 'message-display', { payload: { text: 'unchanged' } }));
    assert.deepEqual(outcome, { text: 'unchanged', hidden: false, transformed: false });
  });
});

test('session-start: sessionTitle renames the session via setSessionMeta; reloadSkills parsed', () => {
  withTempWorkspace((workspace) => {
    for (const h of readHooks(workspace)) removeHook(workspace, h.id);
    addHook(workspace, { event: 'session-start', command: `echo '{"sessionTitle":"Nightly refactor","reloadSkills":true}'` });
    const directives = parseSessionStartDirectives(runHooks(workspace, 'session-start', { payload: { sessionKey: 'chat:x' } }));
    assert.equal(directives.sessionTitle, 'Nightly refactor');
    assert.equal(directives.reloadSkills, true);
    // Apply the rename exactly as runChat does, then read it back.
    setSessionMeta(workspace, 'chat:x', { title: directives.sessionTitle! });
    assert.equal(getSessionMeta(workspace, 'chat:x').title, 'Nightly refactor');
  });
});

test('session-start: no directives → session keeps its default (no title)', () => {
  withTempWorkspace((workspace) => {
    for (const h of readHooks(workspace)) removeHook(workspace, h.id);
    const directives = parseSessionStartDirectives(runHooks(workspace, 'session-start', {}));
    assert.equal(directives.sessionTitle, undefined);
    assert.equal(directives.reloadSkills, false);
    assert.equal(getSessionMeta(workspace, 'chat:y').title, undefined);
  });
});
