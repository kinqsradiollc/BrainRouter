import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopSessionModePatchFromArgs, mergeSessionModePrefs } from './sessionModeBridge.js';
test('desktopSessionModePatchFromArgs accepts valid session-scoped fields', () => {
    assert.deepEqual(desktopSessionModePatchFromArgs({
        executionMode: 'fast',
        reviewPolicy: 'proceed',
        effort: 'xhigh',
    }), {
        patch: { executionMode: 'fast', reviewPolicy: 'proceed', effort: 'xhigh' },
    });
});
test('desktopSessionModePatchFromArgs rejects invalid values before writing', () => {
    assert.match(desktopSessionModePatchFromArgs({ executionMode: 'auto' }).error ?? '', /execution mode/);
    assert.match(desktopSessionModePatchFromArgs({ reviewPolicy: 'always' }).error ?? '', /review policy/);
    assert.match(desktopSessionModePatchFromArgs({ effort: 'maximum' }).error ?? '', /effort/);
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
    }), {
        executionMode: 'fast',
        reviewPolicy: 'proceed',
        effort: 'high',
        theme: 'dark',
    });
});
