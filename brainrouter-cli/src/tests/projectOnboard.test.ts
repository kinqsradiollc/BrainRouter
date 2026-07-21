/**
 * ADR-021 W2 — project onboarding pure helpers: deterministic profile
 * suggestion from repo signals, numbered-answer resolution, and the
 * onboarded-summary formatting. The interactive flow itself stays thin over
 * these + the shared prompt primitives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceManifest } from '@kinqs/brainrouter-core/workspace';
import { formatManifestSummary, resolveProfileAnswer, suggestWorkspaceProfile } from '../cli/commands/init/projectOnboard.js';

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboard-'));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, 'utf8');
  }
  return root;
}

test('suggestWorkspaceProfile: notebooks → data-science (beats code markers)', () => {
  const ws = makeWorkspace({ 'analysis.ipynb': '{}', 'package.json': '{}' });
  try {
    assert.equal(suggestWorkspaceProfile(ws).profile, 'data-science');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('suggestWorkspaceProfile: build manifests → engineering, with reasons', () => {
  const ws = makeWorkspace({ 'package.json': '{}', 'tsconfig.json': '{}' });
  try {
    const suggestion = suggestWorkspaceProfile(ws);
    assert.equal(suggestion.profile, 'engineering');
    assert.ok(suggestion.reasons.some((reason) => reason.includes('package.json')));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('suggestWorkspaceProfile: bibliography → research; md-dominant → writing; empty → custom', () => {
  const research = makeWorkspace({ 'refs.bib': '@article{}' });
  const writing = makeWorkspace({ 'ch1.md': '#', 'ch2.md': '#', 'ch3.md': '#' });
  const empty = makeWorkspace({});
  try {
    assert.equal(suggestWorkspaceProfile(research).profile, 'research');
    assert.equal(suggestWorkspaceProfile(writing).profile, 'writing');
    assert.equal(suggestWorkspaceProfile(empty).profile, 'custom');
  } finally {
    for (const ws of [research, writing, empty]) fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('suggestWorkspaceProfile never throws on an unreadable root', () => {
  assert.equal(suggestWorkspaceProfile('/definitely/not/a/real/path-xyz').profile, 'custom');
});

test('resolveProfileAnswer: empty → suggested; index, id, and unique prefix all resolve', () => {
  assert.equal(resolveProfileAnswer('', 'research'), 'research');
  assert.equal(resolveProfileAnswer('1', 'custom'), 'engineering');
  assert.equal(resolveProfileAnswer('study', 'custom'), 'study');
  assert.equal(resolveProfileAnswer('eng', 'custom'), 'engineering');
  assert.equal(resolveProfileAnswer('data', 'custom'), 'data-science');
});

test('resolveProfileAnswer: garbage and out-of-range → null (wizard re-asks)', () => {
  assert.equal(resolveProfileAnswer('99', 'custom'), null);
  assert.equal(resolveProfileAnswer('0', 'custom'), null);
  assert.equal(resolveProfileAnswer('zzz', 'custom'), null);
});

test('formatManifestSummary includes profile, persona, and edit pointer', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard', at: '2026-07-21T00:00:00Z' });
  const summary = formatManifestSummary(manifest);
  assert.ok(summary.includes('demo'));
  assert.ok(summary.includes('engineering'));
  assert.ok(summary.includes('engineer'));
  assert.ok(summary.includes('.brainrouter/workspace.json'));
});
