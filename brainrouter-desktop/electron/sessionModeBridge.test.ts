import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopSessionModePatchFromArgs, mergeSessionModePrefs } from './sessionModeBridge.js';

test('desktopSessionModePatchFromArgs accepts valid session-scoped fields', () => {
  assert.deepEqual(desktopSessionModePatchFromArgs({
    executionMode: 'fast',
    reviewPolicy: 'proceed',
    effort: 'xhigh',
    personality: 'detailed',
  }), {
    patch: {
      executionMode: 'fast',
      reviewPolicy: 'proceed',
      effort: 'xhigh',
      personality: 'detailed',
    },
  });
});

test('desktop effort bridge accepts canonical none/minimal/max and rejects ultracode', () => {
  for (const effort of ['none', 'minimal', 'max']) {
    assert.deepEqual(desktopSessionModePatchFromArgs({ effort }), { patch: { effort } });
  }
  assert.match(desktopSessionModePatchFromArgs({ effort: 'ultracode' }).error ?? '', /Unknown effort/);
});

test('desktopSessionModePatchFromArgs rejects invalid values before writing', () => {
  assert.match(desktopSessionModePatchFromArgs({ executionMode: 'auto' }).error ?? '', /execution mode/);
  assert.match(desktopSessionModePatchFromArgs({ reviewPolicy: 'always' }).error ?? '', /review policy/);
  assert.match(desktopSessionModePatchFromArgs({ effort: 'maximum' }).error ?? '', /effort/);
  assert.match(desktopSessionModePatchFromArgs({ personality: 'caveman' }).error ?? '', /personality/);
});

test('mergeSessionModePrefs overlays active session mode onto workspace prefs', () => {
  assert.deepEqual(mergeSessionModePrefs({
    executionMode: 'planning',
    reviewPolicy: 'request',
    effort: 'medium',
    theme: 'dark',
  }, {
    executionMode: 'fast',
    reviewPolicy: 'proceed',
    effort: 'high',
  }, {
    style: 'concise',
    source: 'chat',
  }), {
    executionMode: 'fast',
    reviewPolicy: 'proceed',
    effort: 'high',
    personality: 'concise',
    personalitySource: 'chat',
    theme: 'dark',
  });
});
