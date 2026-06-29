import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLibnut, resetLibnutCacheForTests } from './computerUseLibnut.js';
test('computer-use libnut loader refuses pure Wayland before loading native binding', () => {
    const oldWayland = process.env.WAYLAND_DISPLAY;
    const oldDisplay = process.env.DISPLAY;
    const oldPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    resetLibnutCacheForTests();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    delete process.env.DISPLAY;
    try {
        const result = loadLibnut();
        assert.equal(result.ok, false);
        if (!result.ok)
            assert.match(result.error, /Wayland/);
    }
    finally {
        resetLibnutCacheForTests();
        if (oldPlatform)
            Object.defineProperty(process, 'platform', oldPlatform);
        if (oldWayland === undefined)
            delete process.env.WAYLAND_DISPLAY;
        else
            process.env.WAYLAND_DISPLAY = oldWayland;
        if (oldDisplay === undefined)
            delete process.env.DISPLAY;
        else
            process.env.DISPLAY = oldDisplay;
    }
});
