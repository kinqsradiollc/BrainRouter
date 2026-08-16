import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The suite runs from compiled `dist/planner`, while contributors may also run
// it directly from `src/planner`; this package-root-relative path works in both.
const surface = readFileSync(new URL('../../src/planner/PlannerSurface.tsx', import.meta.url), 'utf8');

test('ADR-038 conflict actions never render as silent no-ops', () => {
  assert.match(
    surface,
    /\{ops\.resolveConflict \? \([\s\S]{0,500}>Keep version A<\/[\s\S]{0,300}>Keep version B<\//,
  );
  assert.doesNotMatch(surface, />Mine<|>Source</);
  assert.match(surface, /versionA\.value[\s\S]{0,250}versionB\.value/);
});
