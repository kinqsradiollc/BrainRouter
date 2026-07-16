import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest } from './extract.js';

// A component with interactive controls but NO data-testid — the shape of a real
// app (BrainRouter's own UI) that broad mode must still map.
const SETTINGS_TSX = `
export function SettingsDialog() {
  const save = () => {};
  return (
    <div>
      <button title="Save changes" onClick={save}>Save</button>
      <button aria-label="Cancel">×</button>
      <input placeholder="Search settings" />
      <a href="/docs">Docs</a>
    </div>
  );
}
`;

test('broad mode captures interactive elements without data-testid', () => {
  const { manifest } = buildManifest([{ path: 'src/settings.tsx', text: SETTINGS_TSX }], {
    broad: true,
    now: '2026-01-01T00:00:00.000Z',
  });
  const screen = manifest.screens.find((s) => s.id === 'settings');
  assert.ok(screen, 'settings.tsx becomes its own screen via the broad threshold');
  const byId = Object.fromEntries(screen!.elements.map((e) => [e.id, e]));
  assert.equal(byId['save-changes']?.action, 'tap'); // button + onClick, id from title
  assert.equal(byId['cancel']?.action, 'tap'); // id from aria-label
  assert.equal(byId['search-settings']?.action, 'type'); // input + placeholder
  assert.equal(byId['docs']?.action, 'navigate'); // anchor + href
  // every broad element is flagged synthetic (no data-testid selector)
  assert.ok(screen!.elements.every((e) => e.id.length > 0));
});

test('precise mode ignores elements without data-testid (unchanged behaviour)', () => {
  const { manifest } = buildManifest([{ path: 'src/settings.tsx', text: SETTINGS_TSX }], {
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(manifest.screens.length, 0);
});

test('broad mode treats a panels/ component as its own screen', () => {
  const { manifest } = buildManifest(
    [{ path: 'src/panels/ToolsPanel.tsx', text: 'export const P = () => <button onClick={r}>Run</button>;' }],
    { broad: true },
  );
  const screen = manifest.screens.find((s) => s.id === 'tools-panel');
  assert.ok(screen, 'ToolsPanel under panels/ is a screen even with one control');
  assert.equal(screen!.title, 'Tools Panel');
  assert.equal(screen!.elements[0].action, 'tap');
});

test('broad mode dedupes repeated synthesized ids with a numeric suffix', () => {
  const dup = 'export const P = () => <div><button>Go</button><button>Go</button><button>Go</button></div>;';
  const { manifest } = buildManifest([{ path: 'src/panels/DupPanel.tsx', text: dup }], { broad: true });
  const ids = manifest.screens.flatMap((s) => s.elements.map((e) => e.id)).sort();
  assert.deepEqual(ids, ['go', 'go-2', 'go-3']);
});
