import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAC_WINDOW_CONTROLS_END,
  MAX_ZOOM,
  MIN_ZOOM,
  normalizeZoom,
  stepZoom,
  windowControlsInlineEnd,
} from './useZoom.js';

test('normalizeZoom rejects invalid persistence and clamps the supported range', () => {
  assert.equal(normalizeZoom('not-a-number'), 1);
  assert.equal(normalizeZoom('0.1'), MIN_ZOOM);
  assert.equal(normalizeZoom('9'), MAX_ZOOM);
  assert.equal(normalizeZoom('1.26'), 1.3);
});

test('stepZoom is decimal-stable at both boundaries', () => {
  let value = 1;
  for (let i = 0; i < 30; i++) value = stepZoom(value, 1);
  assert.equal(value, MAX_ZOOM);
  for (let i = 0; i < 40; i++) value = stepZoom(value, -1);
  assert.equal(value, MIN_ZOOM);
});

test('the macOS window-controls inset remains physically fixed across zoom', () => {
  assert.equal(windowControlsInlineEnd(1), MAC_WINDOW_CONTROLS_END);
  assert.equal(windowControlsInlineEnd(MIN_ZOOM), 148);
  assert.equal(windowControlsInlineEnd(MAX_ZOOM), 29.6);

  for (const zoom of [MIN_ZOOM, 0.8, 1, 1.2, 1.5, 2, MAX_ZOOM]) {
    assert.ok(
      Math.abs(windowControlsInlineEnd(zoom) * zoom - MAC_WINDOW_CONTROLS_END) < 0.001,
      `window controls drifted at ${zoom}x`,
    );
  }
});
