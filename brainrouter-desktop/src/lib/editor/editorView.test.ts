import test from 'node:test';
import assert from 'node:assert/strict';
import type { EditorTab } from './editorModel.js';
import {
  editorBasename,
  editorBreadcrumbs,
  editorStatusItems,
  formatEditorBytes,
  parseEditorViewPrefs,
  serializeEditorPref,
} from './editorView.js';

const tab: EditorTab = {
  path: 'src/panels/EditorPanel.tsx',
  content: '',
  saved: '',
  language: 'typescript',
  readOnly: false,
  binary: false,
  truncated: false,
  size: 1536,
};

test('parseEditorViewPrefs reads persisted boolean flags', () => {
  assert.deepEqual(parseEditorViewPrefs('1', '0'), { wordWrap: true, minimap: false });
  assert.deepEqual(parseEditorViewPrefs(null, '1'), { wordWrap: false, minimap: true });
  assert.equal(serializeEditorPref(true), '1');
  assert.equal(serializeEditorPref(false), '0');
});

test('editorBreadcrumbs and editorBasename split workspace paths', () => {
  assert.deepEqual(editorBreadcrumbs('/src/panels/EditorPanel.tsx'), ['src', 'panels', 'EditorPanel.tsx']);
  assert.equal(editorBasename('src/panels/EditorPanel.tsx'), 'EditorPanel.tsx');
});

test('editorStatusItems formats cursor, language, encoding, and size', () => {
  assert.deepEqual(editorStatusItems(tab, { line: 4, column: 9 }), ['Ln 4, Col 9', 'typescript', 'UTF-8', '1.5 KB']);
  assert.equal(formatEditorBytes(48), '48 B');
  assert.equal(formatEditorBytes(2 * 1024 * 1024), '2.0 MB');
});

test('editorStatusItems clamps invalid cursor positions and marks read-only', () => {
  assert.deepEqual(editorStatusItems({ ...tab, readOnly: true }, { line: 0, column: -2 }), [
    'Ln 1, Col 1',
    'typescript',
    'UTF-8',
    '1.5 KB',
    'read-only',
  ]);
});
