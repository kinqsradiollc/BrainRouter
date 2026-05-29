import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProjectMarker, activeProjectName, activeProjectTag } from '../config/project.js';
import { projectTagFromName } from '@kinqs/brainrouter-types';

function withWs(fn: (ws: string) => void) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-proj-'));
  try {
    fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test('no marker → null project / null tag', () => {
  withWs((ws) => {
    assert.equal(readProjectMarker(ws), null);
    assert.equal(activeProjectName(ws), null);
    assert.equal(activeProjectTag(ws), null);
  });
});

test('valid marker → name + stable tag', () => {
  withWs((ws) => {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.brainrouter', 'project.json'), JSON.stringify({ name: 'Acme Platform' }));
    assert.equal(activeProjectName(ws), 'Acme Platform');
    assert.equal(activeProjectTag(ws), projectTagFromName('Acme Platform'));
    // Tag is case-insensitive + stable.
    assert.equal(projectTagFromName('Acme Platform'), projectTagFromName('acme platform'));
  });
});

test('malformed / empty-name marker → null', () => {
  withWs((ws) => {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.brainrouter', 'project.json'), '{ not json');
    assert.equal(readProjectMarker(ws), null);
    fs.writeFileSync(path.join(ws, '.brainrouter', 'project.json'), JSON.stringify({ name: '   ' }));
    assert.equal(readProjectMarker(ws), null);
  });
});
