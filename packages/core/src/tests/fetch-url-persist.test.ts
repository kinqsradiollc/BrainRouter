/**
 * ADR-044 M4 — a fetched page lands as a durable, recallable artifact.
 *
 * The property: with `cli.webSearch.persistToMemory` on, a successful fetch
 * becomes a markdown artifact (provenance in the summary, source-absolutized
 * links via buildPageArtifact) AND is captured into session memory; with it off
 * — the default — nothing is written. Persistence is best-effort and must never
 * break the fetch, so an unusable host is a silent no-op, not a throw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactRecord } from '@kinqs/brainrouter-types';
import { persistFetchedPage } from '../extension/builtin/handlers/websearch.js';
import { resolveCliKnobs, setCliKnobOverride, _resetCliKnobsCache } from '../config/config.js';
import { listArtifacts } from '../artifact/artifactStore.js';
import type { BuiltinToolHost } from '../extension/builtin/handlers/registry.js';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-m4-'));
}

function mockHost(workspaceRoot: string, captured: ArtifactRecord[]): BuiltinToolHost {
  return {
    workspaceRoot,
    sessionKey: 'sess-m4',
    captureArtifactToMemory: async (record: ArtifactRecord) => { captured.push(record); },
  } as unknown as BuiltinToolHost;
}

function setPersist(on: boolean): void {
  const knobs = resolveCliKnobs({ activeServer: '', servers: {}, cli: { webSearch: { persistToMemory: on } } });
  setCliKnobOverride({ webSearch: knobs.webSearch });
}

test('persists a durable artifact and captures it when persistToMemory is on', async () => {
  const ws = tmpWorkspace();
  const captured: ArtifactRecord[] = [];
  setPersist(true);
  try {
    const id = await persistFetchedPage(mockHost(ws, captured), {
      title: 'Reference Doc',
      url: 'https://ex.test/docs/a',
      text: '# Reference Doc\n\nSee [the spec](/spec).',
    });
    assert.ok(id, 'returns an artifact id');
    const arts = listArtifacts(ws);
    assert.equal(arts.length, 1);
    assert.equal(arts[0]!.format, 'markdown');
    assert.equal(arts[0]!.title, 'Reference Doc');
    assert.match(arts[0]!.summary ?? '', /ex\.test\/docs\/a/); // provenance
    // buildPageArtifact absolutized the relative link against the page URL.
    assert.match(arts[0]!.content ?? '', /\(https:\/\/ex\.test\/spec\)/);
    assert.equal(captured.length, 1, 'captured into session memory');
  } finally {
    _resetCliKnobsCache();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('is a no-op when persistToMemory is off (the default)', async () => {
  const ws = tmpWorkspace();
  const captured: ArtifactRecord[] = [];
  setPersist(false);
  try {
    const id = await persistFetchedPage(mockHost(ws, captured), { title: 'x', url: 'https://ex.test/a', text: 'body' });
    assert.equal(id, undefined);
    assert.equal(listArtifacts(ws).length, 0);
    assert.equal(captured.length, 0);
  } finally {
    _resetCliKnobsCache();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a host with no workspace is a silent no-op, never a throw', async () => {
  const captured: ArtifactRecord[] = [];
  setPersist(true);
  try {
    const id = await persistFetchedPage(mockHost('', captured), { title: 'x', url: 'https://ex.test/a', text: 'body' });
    assert.equal(id, undefined);
    assert.equal(captured.length, 0);
  } finally {
    _resetCliKnobsCache();
  }
});
