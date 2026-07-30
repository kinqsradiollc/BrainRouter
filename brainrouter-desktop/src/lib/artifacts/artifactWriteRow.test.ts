import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArtifactWriteSummary, artifactWriteLine } from './artifactWriteRow.js';

test('parses a create result into its structured fields', () => {
  const summary = 'Created artifact art_9f2 (v1, markdown-report, markdown): Release notes. Update it later with artifact_write({ id: "art_9f2", content }).';
  assert.deepEqual(parseArtifactWriteSummary(summary), {
    id: 'art_9f2',
    version: 1,
    kind: 'markdown-report',
    format: 'markdown',
    title: 'Release notes',
    action: 'created',
  });
});

test('parses an update result (unicode arrow + version bump)', () => {
  const summary = 'Updated artifact art_abc → v3 (html-prototype, html): Landing page';
  assert.deepEqual(parseArtifactWriteSummary(summary), {
    id: 'art_abc',
    version: 3,
    kind: 'html-prototype',
    format: 'html',
    title: 'Landing page',
    action: 'updated',
  });
});

test('keeps a title that contains punctuation and periods on create', () => {
  const summary = 'Created artifact art_1 (v1, design-note, markdown): API v2.0: auth, limits, quotas. Update it later with artifact_write({ id: "art_1", content }).';
  const info = parseArtifactWriteSummary(summary);
  assert.equal(info?.title, 'API v2.0: auth, limits, quotas');
  assert.equal(info?.format, 'markdown');
});

test('returns null for a non-artifact summary or empty input', () => {
  assert.equal(parseArtifactWriteSummary('Read 40 lines of src/app.ts'), null);
  assert.equal(parseArtifactWriteSummary(''), null);
  assert.equal(parseArtifactWriteSummary(undefined), null);
});

test('artifactWriteLine renders a compact descriptor', () => {
  assert.equal(artifactWriteLine({ action: 'created', kind: 'markdown-report', version: 1 }), 'Created · markdown-report · v1');
  assert.equal(artifactWriteLine({ action: 'updated', kind: 'sketch', version: 4 }), 'Updated · sketch · v4');
});
