/**
 * ADR-021 W3a — the main-process onboarding bridge: manifest info assembly and
 * strict payload validation (reject, never coerce). Runs against real tmp
 * workspaces; the IPC layer in main.ts is a thin trusted-root guard over these.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWorkspaceManifest } from '@kinqs/brainrouter-core/workspace';
import { getWorkspaceManifestInfo, saveWorkspaceManifestFromPayload } from './workspaceOnboarding.js';

function tmpWorkspace(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboard-ipc-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body, 'utf8');
  }
  return root;
}

test('manifest-get: un-onboarded workspace → suggestion + full profile catalog', () => {
  const ws = tmpWorkspace({ 'package.json': '{}' });
  try {
    const info = getWorkspaceManifestInfo(ws);
    assert.equal(info.onboarded, false);
    assert.equal(info.manifest, null);
    assert.equal(info.suggestion.profile, 'engineering');
    assert.ok(info.profiles.length >= 6);
    assert.ok(info.profiles.some((preset) => preset.id === 'custom'));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('manifest-save: valid profile writes through the chokepoint; round-trips', () => {
  const ws = tmpWorkspace();
  try {
    const result = saveWorkspaceManifestFromPayload(ws, { profile: 'research' });
    assert.ok(result.saved);
    const loaded = loadWorkspaceManifest(ws);
    assert.equal(loaded?.profile, 'research');
    assert.equal(loaded?.agents.default, 'researcher');
    assert.equal(loaded?.onboarded.by, 'wizard');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('manifest-save: engineering persona pick promotes frontend-builder to default', () => {
  const ws = tmpWorkspace();
  try {
    const result = saveWorkspaceManifestFromPayload(ws, { profile: 'engineering', defaultAgent: 'frontend-builder' });
    assert.ok(result.saved);
    assert.equal(result.saved && result.manifest.agents.default, 'frontend-builder');
    assert.ok(result.saved && result.manifest.agents.enabled.includes('engineer'), 'engineer stays enabled');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('manifest-save REJECTS: unknown profile, foreign persona, malformed persona, double onboard', () => {
  const ws = tmpWorkspace();
  try {
    assert.equal(saveWorkspaceManifestFromPayload(ws, { profile: 'astrology' }).saved, false);
    assert.equal(saveWorkspaceManifestFromPayload(ws, { profile: 'research', defaultAgent: 'engineer' }).saved, false, 'persona not offered by the profile');
    assert.equal(saveWorkspaceManifestFromPayload(ws, { profile: 'engineering', defaultAgent: '../evil' }).saved, false, 'malformed persona id');
    assert.equal(loadWorkspaceManifest(ws), null, 'rejected payloads write NOTHING');

    assert.ok(saveWorkspaceManifestFromPayload(ws, { profile: 'study' }).saved);
    const second = saveWorkspaceManifestFromPayload(ws, { profile: 'writing' });
    assert.equal(second.saved, false, 'already-onboarded workspaces are not re-onboarded here');
    assert.equal(loadWorkspaceManifest(ws)?.profile, 'study', 'first manifest untouched');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
