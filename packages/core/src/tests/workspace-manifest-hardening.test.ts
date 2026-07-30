import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_MANIFEST_MAX_BYTES,
  WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES,
  WORKSPACE_MANIFEST_MAX_EXTRA_DEPTH,
  WORKSPACE_MANIFEST_MAX_STRING_BYTES,
  createWorkspaceManifest,
  loadWorkspaceManifest,
  normalizeWorkspaceManifest,
  saveWorkspaceManifest,
  serializeWorkspaceManifest,
  workspaceManifestPath,
} from '../workspace/manifest.js';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-manifest-hardening-'));
}

function writeRawManifest(workspace: string, value: unknown): void {
  fs.mkdirSync(path.join(workspace, '.brainrouter'), { recursive: true });
  fs.writeFileSync(workspaceManifestPath(workspace), JSON.stringify(value));
}

test('manifest loading accepts the byte limit and rejects larger input', () => {
  const workspace = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(workspace, '.brainrouter'), { recursive: true });
    const prefix = '{"profile":"custom","padding":"';
    const suffix = '"}';
    const paddingBytes = WORKSPACE_MANIFEST_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const exactLimit = `${prefix}${'x'.repeat(paddingBytes)}${suffix}`;
    fs.writeFileSync(workspaceManifestPath(workspace), exactLimit);
    assert.equal(loadWorkspaceManifest(workspace)?.profile, 'custom');

    fs.appendFileSync(workspaceManifestPath(workspace), ' ');
    assert.equal(loadWorkspaceManifest(workspace), null);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('manifest normalization bounds strings, collections, depth, and serialized size', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'custom', by: 'wizard' });
  const boundedString = 'x'.repeat(WORKSPACE_MANIFEST_MAX_STRING_BYTES);
  manifest.agents.enabled = Array.from(
    { length: WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES + 8 },
    (_, index) => `agent-${index}`,
  );
  let atDepthLimit: unknown = 'keep';
  let beyondDepthLimit: unknown = 'drop';
  for (let depth = 0; depth < WORKSPACE_MANIFEST_MAX_EXTRA_DEPTH; depth += 1) {
    atDepthLimit = { nested: atDepthLimit };
  }
  for (let depth = 0; depth <= WORKSPACE_MANIFEST_MAX_EXTRA_DEPTH; depth += 1) {
    beyondDepthLimit = { nested: beyondDepthLimit };
  }
  manifest.extra = {
    boundedString,
    oversizedString: `${boundedString}x`,
    atDepthLimit,
    beyondDepthLimit,
    oversizedPayload: Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`future-${index}`, boundedString]),
    ),
  };

  const first = normalizeWorkspaceManifest(manifest);
  const second = normalizeWorkspaceManifest(manifest);
  assert.deepEqual(first, second, 'normalization remains deterministic');
  assert.equal(first.agents.enabled.length, WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES);
  assert.equal(first.extra?.boundedString, boundedString);
  assert.equal(Object.hasOwn(first.extra ?? {}, 'oversizedString'), false);
  assert.ok(JSON.stringify(first.extra?.atDepthLimit).includes('keep'));
  assert.ok(!JSON.stringify(first.extra?.beyondDepthLimit).includes('drop'));
  assert.ok(Buffer.byteLength(serializeWorkspaceManifest(first)) <= WORKSPACE_MANIFEST_MAX_BYTES);
});

test('committable manifests discard credentials and local paths while preserving safe extras', () => {
  const workspace = tmpWorkspace();
  try {
    writeRawManifest(workspace, {
      profile: 'engineering',
      instructions: '/Users/example/private/AGENT.md',
      agents: { default: 'engineer', enabled: ['engineer', 'ghp_abcdefghijklmnopqrstuvwxyz'] },
      tools: { profiles: ['coding', 'https://example.test/tool?access_token=private'], deny: [] },
      future: {
        keep: true,
        safeUrl: 'https://example.test/public',
        authToken: 'private',
        'api%5Fkey': 'private',
        encodedCredentialUrl: 'https://example.test/callback%3Fapi%255Fkey%3Dprivate',
        localPath: '/Users/example/private/file.txt',
        encodedLocalPath: '%252FUsers%252Fexample%252Fprivate.txt',
      },
    });

    const loaded = loadWorkspaceManifest(workspace);
    assert.ok(loaded);
    assert.equal(loaded.instructions, 'AGENT.md');
    assert.deepEqual(loaded.agents.enabled, ['engineer']);
    assert.deepEqual(loaded.tools.profiles, ['coding']);
    assert.deepEqual(loaded.extra, {
      future: { keep: true, safeUrl: 'https://example.test/public' },
    });

    saveWorkspaceManifest(workspace, loaded);
    const persisted = fs.readFileSync(workspaceManifestPath(workspace), 'utf8');
    assert.ok(!persisted.includes('private'));
    assert.ok(!persisted.includes('ghp_'));
    assert.deepEqual(loadWorkspaceManifest(workspace)?.extra, loaded.extra);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('manifest normalization removes prototype-pollution and display-control keys', () => {
  const workspace = tmpWorkspace();
  try {
    writeRawManifest(workspace, JSON.parse(`{
      "profile": "custom",
      "__proto__": { "polluted": "top" },
      "future": {
        "keep": true,
        "constructor": { "polluted": "nested" },
        "%255F%255Fproto%255F%255F": { "polluted": "encoded" },
        "bad%E2%80%AEkey": "hidden",
        "display%5Fname": "keep"
      }
    }`));

    const loaded = loadWorkspaceManifest(workspace);
    assert.ok(loaded);
    assert.deepEqual(loaded.extra, {
      future: { keep: true, 'display%5Fname': 'keep' },
    });
    assert.equal(({} as { polluted?: string }).polluted, undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
