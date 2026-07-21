/**
 * ADR-021 W1/W1c — the workspace manifest chokepoint: preset application,
 * capability migration, disk round-trip with unknown-field preservation,
 * never-throw loading, and profile-preset self-consistency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_MANIFEST_MAX_BYTES,
  WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES,
  WORKSPACE_MANIFEST_MAX_EXTRA_DEPTH,
  WORKSPACE_MANIFEST_MAX_NORMALIZATION_NODES,
  WORKSPACE_MANIFEST_MAX_STRING_BYTES,
  WORKSPACE_PROFILES,
  createWorkspaceManifest,
  getWorkspaceProfile,
  isWorkspaceOnboarded,
  loadWorkspaceManifest,
  normalizeWorkspaceManifest,
  saveWorkspaceManifest,
  serializeWorkspaceManifest,
  workspaceManifestPath,
} from '../workspace/manifest.js';
import { readWorkspaceFileBounded, writeWorkspaceFileAtomic } from '../workspace/fileWrite.js';
import {
  beginWorkspaceOnboardingPairTransaction,
  endWorkspaceOnboardingPairTransaction,
  markWorkspaceOnboardingInstructionCommitting,
  markWorkspaceOnboardingManifestCommitting,
  recordWorkspaceOnboardingInstructionStaged,
  recordWorkspaceOnboardingInstructionWritten,
  recordWorkspaceOnboardingManifestWritten,
  type WorkspaceOnboardingFileSnapshot,
  type WorkspaceOnboardingPairTransaction,
} from '../workspace/onboardingTransaction.js';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-wsm-'));
}

function serializedDraftBytes(manifest: ReturnType<typeof createWorkspaceManifest>): number {
  const { extra, ...known } = manifest;
  return Buffer.byteLength(`${JSON.stringify({ ...(extra ?? {}), ...known }, null, 2)}\n`);
}

function testFileSnapshot(target: string): WorkspaceOnboardingFileSnapshot {
  try {
    const stat = fs.lstatSync(target);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    return {
      existed: true,
      mode: stat.mode,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      contents: fs.readFileSync(target),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false };
    throw error;
  }
}

function regularFilesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  visit(root);
  return files;
}

test('createWorkspaceManifest applies the profile preset', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  assert.equal(manifest.profile, 'engineering');
  assert.equal(manifest.agents.default, 'engineer');
  assert.deepEqual(manifest.agents.enabled, ['engineer']);
  assert.deepEqual(manifest.capabilities, { enabled: ['frontend'], disabled: [] });
  assert.ok(manifest.skills.enabled.includes('planning-skill'));
  assert.ok(manifest.tools.profiles.includes('coding'));
  assert.ok(!manifest.tools.profiles.includes('design'), 'design tooling activates with frontend task signals');
  assert.deepEqual(manifest.memory.tags, ['engineering']);
  assert.equal(manifest.instructions, 'AGENT.md');
  assert.equal(manifest.onboarded.by, 'wizard');
  assert.ok(manifest.onboarded.at.length > 0);
});

test('custom profile starts empty — nothing imposed', () => {
  const manifest = createWorkspaceManifest({ name: 'x', profile: 'custom', by: 'wizard' });
  assert.equal(manifest.agents.default, '');
  assert.deepEqual(manifest.capabilities, { enabled: [], disabled: [] });
  assert.deepEqual(manifest.skills.packs, []);
  assert.deepEqual(manifest.tools.profiles, []);
});

test('an explicit empty instruction pointer survives normalization', () => {
  const ws = tmpWorkspace();
  try {
    const manifest = createWorkspaceManifest({ name: 'x', profile: 'custom', by: 'wizard' });
    manifest.instructions = '';
    saveWorkspaceManifest(ws, manifest);
    assert.equal(loadWorkspaceManifest(ws)?.instructions, '');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('save → load round-trips, marks onboarded, and preserves unknown fields', () => {
  const ws = tmpWorkspace();
  try {
    assert.equal(isWorkspaceOnboarded(ws), false);
    const manifest = createWorkspaceManifest({ name: 'demo', profile: 'research', by: 'agent', at: '2026-07-21T00:00:00Z' });
    manifest.extra = { futureField: { keep: true } };
    saveWorkspaceManifest(ws, manifest);
    assert.equal(isWorkspaceOnboarded(ws), true);

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.equal(loaded.profile, 'research');
    assert.equal(loaded.agents.default, 'researcher');
    assert.equal(loaded.onboarded.at, '2026-07-21T00:00:00Z');
    assert.deepEqual(loaded.extra, { futureField: { keep: true } }, 'unknown fields survive the round-trip');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest load rolls back an owned instruction left before pair commit', () => {
  const ws = tmpWorkspace();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-wsm-home-'));
  const previousHome = process.env.BRAINROUTER_HOME;
  const original = createWorkspaceManifest({ name: 'before-pair', profile: 'engineering', by: 'wizard' });
  const manifest = createWorkspaceManifest({ name: 'partial-pair', profile: 'research', by: 'wizard' });
  const instructionPath = path.join(ws, 'AGENT.md');
  let transaction: WorkspaceOnboardingPairTransaction | undefined;
  process.env.BRAINROUTER_HOME = home;
  try {
    fs.writeFileSync(instructionPath, '# Before\n', { mode: 0o640 });
    saveWorkspaceManifest(ws, original);
    const manifestBefore = fs.readFileSync(workspaceManifestPath(ws));
    const manifestInode = fs.statSync(workspaceManifestPath(ws)).ino;
    transaction = beginWorkspaceOnboardingPairTransaction(ws, {
      manifestBefore: testFileSnapshot(workspaceManifestPath(ws)),
      manifestDesired: serializeWorkspaceManifest(manifest),
      instructionBefore: testFileSnapshot(instructionPath),
      instructionDesired: '# Instructions\n',
    });
    markWorkspaceOnboardingInstructionCommitting(transaction);
    writeWorkspaceFileAtomic(ws, 'AGENT.md', '# Instructions\n', {
      onStaged: (staged) => recordWorkspaceOnboardingInstructionStaged(transaction!, staged),
    });
    recordWorkspaceOnboardingInstructionWritten(transaction, 'created', testFileSnapshot(instructionPath));
    endWorkspaceOnboardingPairTransaction(transaction);
    transaction = undefined;

    assert.equal(fs.existsSync(instructionPath), true);
    assert.deepEqual(loadWorkspaceManifest(ws), original);
    assert.equal(fs.readFileSync(instructionPath, 'utf8'), '# Before\n');
    assert.equal(fs.statSync(instructionPath).mode & 0o777, 0o640);
    assert.deepEqual(fs.readFileSync(workspaceManifestPath(ws)), manifestBefore);
    assert.equal(fs.statSync(workspaceManifestPath(ws)).ino, manifestInode);
    assert.deepEqual(regularFilesUnder(home), [], 'the recovery receipt and atomic temp are retired');
    assert.ok(
      fs.readdirSync(ws).every((name) => !name.endsWith('.tmp') && !name.endsWith('.onboarding-recovery')),
      'workspace recovery leaves no staged or quarantine artifact',
    );
  } finally {
    if (transaction) endWorkspaceOnboardingPairTransaction(transaction);
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest load accepts a fully written pair left before receipt cleanup', () => {
  const ws = tmpWorkspace();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-wsm-home-'));
  const previousHome = process.env.BRAINROUTER_HOME;
  const manifest = createWorkspaceManifest({ name: 'complete-pair', profile: 'research', by: 'wizard' });
  let transaction: WorkspaceOnboardingPairTransaction | undefined;
  process.env.BRAINROUTER_HOME = home;
  try {
    transaction = beginWorkspaceOnboardingPairTransaction(ws, {
      manifestBefore: { existed: false },
      manifestDesired: serializeWorkspaceManifest(manifest),
      instructionBefore: { existed: false },
      instructionDesired: '# Instructions\n',
    });
    markWorkspaceOnboardingInstructionCommitting(transaction);
    writeWorkspaceFileAtomic(ws, 'AGENT.md', '# Instructions\n', {
      exclusive: true,
      onStaged: (staged) => recordWorkspaceOnboardingInstructionStaged(transaction!, staged),
    });
    recordWorkspaceOnboardingInstructionWritten(
      transaction,
      'created',
      testFileSnapshot(path.join(ws, 'AGENT.md')),
    );
    markWorkspaceOnboardingManifestCommitting(transaction);
    saveWorkspaceManifest(ws, manifest);
    recordWorkspaceOnboardingManifestWritten(transaction, testFileSnapshot(workspaceManifestPath(ws)));
    endWorkspaceOnboardingPairTransaction(transaction);
    transaction = undefined;

    assert.deepEqual(loadWorkspaceManifest(ws), manifest);
    assert.equal(fs.readFileSync(path.join(ws, 'AGENT.md'), 'utf8'), '# Instructions\n');
    assert.deepEqual(regularFilesUnder(home), [], 'the committed-pair receipt is retired');
    assert.ok(
      fs.readdirSync(ws).every((name) => !name.endsWith('.tmp') && !name.endsWith('.onboarding-recovery')),
      'committed-pair recovery leaves no staged or quarantine artifact',
    );
  } finally {
    if (transaction) endWorkspaceOnboardingPairTransaction(transaction);
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest load fails closed when a matching pair receipt is invalid', () => {
  const ws = tmpWorkspace();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-wsm-home-'));
  const previousHome = process.env.BRAINROUTER_HOME;
  const manifest = createWorkspaceManifest({ name: 'invalid-receipt', profile: 'research', by: 'wizard' });
  let transaction: WorkspaceOnboardingPairTransaction | undefined;
  process.env.BRAINROUTER_HOME = home;
  try {
    transaction = beginWorkspaceOnboardingPairTransaction(ws, {
      manifestBefore: { existed: false },
      manifestDesired: serializeWorkspaceManifest(manifest),
      instructionBefore: { existed: false },
      instructionDesired: '# Instructions\n',
    });
    const receiptPath = transaction.receiptPath;
    endWorkspaceOnboardingPairTransaction(transaction);
    transaction = undefined;
    fs.writeFileSync(receiptPath, '{}\n');
    fs.writeFileSync(path.join(ws, 'AGENT.md'), '# Instructions\n');
    saveWorkspaceManifest(ws, manifest);

    assert.equal(loadWorkspaceManifest(ws), null, 'an invalid recovery receipt must block accepting the pair');
    assert.equal(fs.readFileSync(path.join(ws, 'AGENT.md'), 'utf8'), '# Instructions\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(workspaceManifestPath(ws), 'utf8')), manifest);
    assert.equal(fs.existsSync(receiptPath), true, 'invalid evidence is preserved for manual recovery');
  } finally {
    if (transaction) endWorkspaceOnboardingPairTransaction(transaction);
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('new workspace manifests honor the process umask', { skip: process.platform === 'win32' }, () => {
  const ws = tmpWorkspace();
  try {
    const expectedMode = 0o666 & ~process.umask();
    saveWorkspaceManifest(ws, createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' }));
    assert.equal(fs.statSync(workspaceManifestPath(ws)).mode & 0o777, expectedMode);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest persistence rejects parent and target symlinks without touching external files', { skip: process.platform === 'win32' }, () => {
  const ws = tmpWorkspace();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'br-wsm-external-'));
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  try {
    fs.symlinkSync(external, path.join(ws, '.brainrouter'));
    assert.throws(() => saveWorkspaceManifest(ws, manifest), /Unsafe workspace directory/);
    assert.equal(fs.existsSync(path.join(external, 'workspace.json')), false);

    fs.rmSync(path.join(ws, '.brainrouter'));
    fs.mkdirSync(path.join(ws, '.brainrouter'));
    const liveTarget = path.join(external, 'live.json');
    fs.writeFileSync(liveTarget, '{"keep":true}\n');
    fs.symlinkSync(liveTarget, workspaceManifestPath(ws));
    assert.equal(loadWorkspaceManifest(ws), null, 'loads never follow a manifest symlink');
    assert.throws(() => saveWorkspaceManifest(ws, manifest), /Unsafe workspace file/);
    assert.equal(fs.readFileSync(liveTarget, 'utf8'), '{"keep":true}\n');

    fs.rmSync(workspaceManifestPath(ws));
    const danglingTarget = path.join(external, 'dangling.json');
    fs.symlinkSync(danglingTarget, workspaceManifestPath(ws));
    assert.throws(() => saveWorkspaceManifest(ws, manifest), /Unsafe workspace file/);
    assert.equal(fs.existsSync(danglingTarget), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('workspace reads and writes reject a parent-directory symlink swap', { skip: process.platform === 'win32' }, () => {
  const ws = tmpWorkspace();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'br-wsm-swap-external-'));
  const parent = path.join(ws, '.brainrouter');
  const displaced = path.join(ws, '.brainrouter-displaced');
  const relativePath = path.join('.brainrouter', 'workspace.json');
  try {
    fs.mkdirSync(parent);
    fs.writeFileSync(path.join(parent, 'workspace.json'), 'original');
    fs.writeFileSync(path.join(external, 'workspace.json'), 'external');

    assert.throws(() => readWorkspaceFileBounded(ws, relativePath, 1024, {
      beforeOpen: () => {
        fs.renameSync(parent, displaced);
        fs.symlinkSync(external, parent);
      },
    }), /Workspace directory changed during access/);
    assert.equal(fs.readFileSync(path.join(external, 'workspace.json'), 'utf8'), 'external');

    fs.rmSync(parent);
    fs.renameSync(displaced, parent);
    assert.throws(() => writeWorkspaceFileAtomic(ws, relativePath, 'replacement', {
      beforeCommit: () => {
        fs.renameSync(parent, displaced);
        fs.symlinkSync(external, parent);
      },
    }), /Workspace directory changed during access/);
    assert.equal(fs.readFileSync(path.join(external, 'workspace.json'), 'utf8'), 'external');
    assert.equal(fs.readFileSync(path.join(displaced, 'workspace.json'), 'utf8'), 'original');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('manifest loading accepts the byte limit and rejects larger committed input', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    const prefix = '{"profile":"custom","padding":"';
    const suffix = '"}';
    const paddingBytes = WORKSPACE_MANIFEST_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const exactLimit = `${prefix}${'x'.repeat(paddingBytes)}${suffix}`;
    assert.equal(Buffer.byteLength(exactLimit), WORKSPACE_MANIFEST_MAX_BYTES);

    fs.writeFileSync(workspaceManifestPath(ws), exactLimit);
    assert.equal(loadWorkspaceManifest(ws)?.profile, 'custom', 'the exact byte limit remains readable');

    fs.appendFileSync(workspaceManifestPath(ws), ' ');
    assert.equal(fs.statSync(workspaceManifestPath(ws)).size, WORKSPACE_MANIFEST_MAX_BYTES + 1);
    assert.equal(loadWorkspaceManifest(ws), null, 'oversized committed input is rejected before parsing');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest normalization bounds known fields and forward-compatible extras at exact limits', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'custom', by: 'wizard' });
  const exactString = 'x'.repeat(WORKSPACE_MANIFEST_MAX_STRING_BYTES);
  manifest.name = exactString;
  manifest.agents.enabled = Array.from(
    { length: WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES + 1 },
    (_, index) => `agent-${index}`,
  );
  manifest.extra = {
    exactString,
    oversizedString: `${exactString}x`,
    exactList: Array.from(
      { length: WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES },
      (_, index) => `item-${index}`,
    ),
    oversizedList: Array.from(
      { length: WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES + 1 },
      (_, index) => `item-${index}`,
    ),
  };

  const normalized = normalizeWorkspaceManifest(manifest);
  assert.equal(normalized.name, exactString, 'a string at the byte limit survives');
  assert.equal(normalized.agents.enabled.length, WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES);
  assert.equal(normalized.extra?.exactString, exactString);
  assert.equal(Object.hasOwn(normalized.extra ?? {}, 'oversizedString'), false);
  assert.equal((normalized.extra?.exactList as unknown[]).length, WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES);
  assert.equal((normalized.extra?.oversizedList as unknown[]).length, WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES);

  manifest.name = `${exactString}x`;
  assert.equal(normalizeWorkspaceManifest(manifest).name, 'workspace', 'a known string over the limit defaults safely');
});

test('manifest normalization caps object width, nesting depth, and total traversal', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'custom', by: 'wizard' });
  const wideObject = Object.fromEntries(Array.from(
    { length: WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES + 1 },
    (_, index) => [`field-${index}`, index],
  ));
  let atDepthLimit: unknown = 'keep';
  let beyondDepthLimit: unknown = 'drop';
  for (let depth = 0; depth < WORKSPACE_MANIFEST_MAX_EXTRA_DEPTH; depth += 1) {
    atDepthLimit = { nested: atDepthLimit };
  }
  for (let depth = 0; depth <= WORKSPACE_MANIFEST_MAX_EXTRA_DEPTH; depth += 1) {
    beyondDepthLimit = { nested: beyondDepthLimit };
  }
  const manyNodes = Object.fromEntries(Array.from(
    { length: 32 },
    (_, group) => [`group-${group}`, { ...wideObject }],
  ));
  manifest.extra = { wideObject, atDepthLimit, beyondDepthLimit, manyNodes };

  const normalized = normalizeWorkspaceManifest(manifest);
  assert.equal(Object.keys(normalized.extra?.wideObject as object).length, WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES);
  assert.ok(JSON.stringify(normalized.extra?.atDepthLimit).includes('keep'));
  assert.ok(!JSON.stringify(normalized.extra?.beyondDepthLimit).includes('drop'));

  const countNodes = (value: unknown): number => {
    if (Array.isArray(value)) return 1 + value.reduce((total, item) => total + countNodes(item), 0);
    if (value && typeof value === 'object') {
      return 1 + Object.values(value).reduce<number>((total, item) => total + countNodes(item), 0);
    }
    return 1;
  };
  assert.ok(countNodes(normalized.extra) <= WORKSPACE_MANIFEST_MAX_NORMALIZATION_NODES);
});

test('manifest normalization deterministically fits every returned draft under the loader cap', () => {
  const ws = tmpWorkspace();
  try {
    const manifest = createWorkspaceManifest({ name: 'demo', profile: 'custom', by: 'wizard' });
    manifest.extra = Object.fromEntries(Array.from(
      { length: 80 },
      (_, index) => [`future-${index}`, 'x'.repeat(WORKSPACE_MANIFEST_MAX_STRING_BYTES)],
    ));

    const first = normalizeWorkspaceManifest(manifest);
    const second = normalizeWorkspaceManifest(manifest);
    assert.deepEqual(first, second, 'trimming is deterministic');
    assert.ok(serializedDraftBytes(first) <= WORKSPACE_MANIFEST_MAX_BYTES);
    assert.ok(Object.keys(first.extra ?? {}).length > 0, 'a fitting prefix of safe extras survives');
    assert.ok(Object.keys(first.extra ?? {}).length < 80, 'only the oversized suffix is trimmed');

    saveWorkspaceManifest(ws, manifest);
    assert.ok(fs.statSync(workspaceManifestPath(ws)).size <= WORKSPACE_MANIFEST_MAX_BYTES);
    assert.ok(loadWorkspaceManifest(ws), 'every saved normalized draft remains readable');

    const largeValues = Array.from(
      { length: WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES },
      (_, index) => `${String(index).padStart(4, '0')}${'x'.repeat(WORKSPACE_MANIFEST_MAX_STRING_BYTES - 4)}`,
    );
    const created = createWorkspaceManifest({
      name: 'large',
      profile: 'custom',
      by: 'wizard',
      overrides: { agents: { default: 'engineer', enabled: largeValues } },
    });
    assert.ok(serializedDraftBytes(created) <= WORKSPACE_MANIFEST_MAX_BYTES, 'fresh drafts are fitted too');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('committable manifest drops sensitive extras and local paths but preserves safe future fields', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      profile: 'engineering',
      instructions: '/Users/example/private/AGENT.md',
      futureField: {
        keep: true,
        tokenBudget: 4096,
        maxTokens: 8192,
        inputTokens: 128,
        outputTokens: 256,
        tokenizerModel: 'example-tokenizer',
        authToken: 'hidden',
        githubToken: 'hidden',
        apiSecretKey: 'hidden',
        accessTokenValue: 'hidden',
        authTokenValue: 'hidden',
        oauthTokenValue: 'hidden',
        csrfTokenValue: 'hidden',
        projectId: 'project-secret',
        orgIds: ['org-secret'],
        projectIds: ['project-secret'],
        buildCommand: 'node /Users/example/private/build.js',
        bracketedUnixPath: 'paths=[/Users/example/private]',
        bracketedWindowsPath: 'paths=[C:\\Users\\example\\private]',
        labelledPath: 'path:/Users/example/private',
        safeUrl: 'https://example.test/api',
        authorizationUrl: 'https://example.test/oauth/authorize',
        documentationUri: 'https://example.test/docs?lang=en#intro',
        userinfoUrl: 'https://alice:private@example.test/api',
        databaseUri: 'postgresql://alice:private@example.test/data',
        queryTokenUrl: 'https://example.test/callback?access_token=private',
        encodedCredentialUri: 'https://example.test/callback%3Fapi%255Fkey%3Dprivate',
        fragmentSecretUrl: 'https://example.test/callback#client_secret=private',
        bidiCredentialUrl: 'https://example.test/callback?to\u202eken=private',
        malformedEscapeUrl: 'https://example.test/callback?bad=%ZZ&access%5Ftoken=private',
        tripleEncodedQueryUrl: 'https://example.test/callback?token%25253Dprivate',
        awsCredentialUrl: 'https://example.test/object?X-Amz-Credential=private',
        awsSignatureUrl: 'https://example.test/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=private',
        encodedLocalFileUri: 'file%3A%2F%2F%2FUsers%2Fexample%2Fprivate.txt',
        malformedEncodedLocalPath: 'note=%ZZ&path=%2FUsers%2Fexample%2Fprivate.txt',
        doubleEncodedLocalPath: '%252FUsers%252Fexample%252Fprivate.txt',
        tripleEncodedLocalPath: '%25252FUsers%25252Fexample%25252Fprivate.txt',
        safeEncodedUrl: 'https%3A%2F%2Fexample.test%2Fpublic',
        safeMalformedUrl: 'https://example.test/public?note=%ZZ',
        tokenizerUrl: 'https://example.test/models?tokenizer=example',
        cookiePolicy: 'strict',
        passwordPolicy: { minimumLength: 16 },
        signedMetadata: 'aaaaaaaa.bbbbbbbb.cccccccc',
        requestExample: 'curl -H "Authorization: Bearer private-token" https://example.test',
        nested: ['safe', '/home/example/private.txt', { clientSecret: 'hidden', note: 'keep me' }],
      },
      apiKey: 'sk-exampleexamplesecret',
      opaque: 'ghp_abcdefghijklmnopqrstuvwxyz',
      agents: { default: 'engineer', enabled: ['engineer', 'ghp_abcdefghijklmnopqrstuvwxyz'] },
      capabilities: { enabled: ['frontend', '/Users/example/private-capability'], disabled: [] },
      skills: {
        packs: ['engineering'],
        enabled: ['file:///Users/example/private-skill', 'file%3A%2F%2F%2FUsers%2Fexample%2Fprivate-skill'],
        disabled: [],
      },
      tools: { profiles: ['coding', 'https://example.test/tool?token=private'], deny: ['Bearer private-token'] },
      memory: { tags: ['engineering', 'sk-anotherexamplesecret'], captureHint: 'code' },
    }), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.equal(loaded.instructions, 'AGENT.md');
    assert.deepEqual(loaded.agents, { default: 'engineer', enabled: ['engineer'] });
    assert.deepEqual(loaded.capabilities, { enabled: ['frontend'], disabled: [] });
    assert.deepEqual(loaded.skills, { packs: ['engineering'], enabled: [], disabled: [] });
    assert.deepEqual(loaded.tools, { profiles: ['coding'], deny: [] });
    assert.deepEqual(loaded.memory, { tags: ['engineering'], captureHint: 'code' });
    assert.deepEqual(loaded.extra, {
      futureField: {
        keep: true,
        tokenBudget: 4096,
        maxTokens: 8192,
        inputTokens: 128,
        outputTokens: 256,
        tokenizerModel: 'example-tokenizer',
        safeUrl: 'https://example.test/api',
        authorizationUrl: 'https://example.test/oauth/authorize',
        documentationUri: 'https://example.test/docs?lang=en#intro',
        safeEncodedUrl: 'https%3A%2F%2Fexample.test%2Fpublic',
        safeMalformedUrl: 'https://example.test/public?note=%ZZ',
        tokenizerUrl: 'https://example.test/models?tokenizer=example',
        cookiePolicy: 'strict',
        passwordPolicy: { minimumLength: 16 },
        nested: ['safe', { note: 'keep me' }],
      },
    });

    saveWorkspaceManifest(ws, loaded);
    const persisted = fs.readFileSync(workspaceManifestPath(ws), 'utf8');
    assert.ok(!persisted.includes('project-secret'));
    assert.ok(!persisted.includes('/home/example'));
    assert.ok(!persisted.includes('/Users/example'));
    assert.ok(!persisted.includes('private-token'));
    assert.ok(!persisted.includes('ghp_'));
    assert.deepEqual(loadWorkspaceManifest(ws)?.extra, loaded.extra);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest normalization strips terminal, line, bidi, and display controls from every retained string', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      name: 'demo\u001b]8;;https://example.test\u0007link\u2028forged\u2066',
      profile: 'engineering',
      onboarded: { at: '2026-07-21\u009b31m', by: 'wizard' },
      agents: { default: 'engineer\u001b[31m', enabled: ['engineer', 'reviewer\rforged\u202e'] },
      capabilities: { enabled: ['frontend\tforged'], disabled: [] },
      skills: { packs: [], enabled: [], disabled: [] },
      tools: { profiles: [], deny: [] },
      memory: { tags: ['engineering\u007f\u200b'], captureHint: 'code\u2029forged' },
      instructions: 'AGENT\u202e.md',
      future: { note: '\u001b[31mred\u2029line\u2066', 'bad\u202ekey': 'drop' },
    }), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.equal(loaded.instructions, 'AGENT.md');
    const retainedStrings: string[] = [];
    const collectStrings = (value: unknown): void => {
      if (typeof value === 'string') retainedStrings.push(value);
      else if (Array.isArray(value)) value.forEach(collectStrings);
      else if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          retainedStrings.push(key);
          collectStrings(nested);
        }
      }
    };
    collectStrings(loaded);
    assert.equal(retainedStrings.some((value) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)), false);
    assert.equal(Object.hasOwn(loaded.extra?.future as object, 'bad\u202ekey'), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest normalization drops prototype-pollution keys from unknown extras', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify(JSON.parse(`{
      "profile": "custom",
      "__proto__": { "polluted": "top" },
      "prototype": { "polluted": "top" },
      "constructor": { "polluted": "top" },
      "future": {
        "keep": true,
        "__proto__": { "polluted": "nested" },
        "prototype": { "polluted": "nested" },
        "constructor": { "polluted": "nested" }
      }
    }`)), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.deepEqual(loaded.extra, { future: { keep: true } });
    assert.equal(({} as { polluted?: string }).polluted, undefined);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest normalization rejects percent-encoded sensitive and unsafe extra keys at every depth', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      profile: 'custom',
      'api%5Fkey': 'top-secret',
      'access%255Ftoken': 'top-secret',
      'api%25255Fkey': 'top-secret',
      '%5F%5Fproto%5F%5F': { polluted: 'top' },
      'bad%E2%80%AEkey': 'hidden',
      'display%5Fname': 'keep-top',
      future: {
        keep: true,
        'api%5Fkey': 'nested-secret',
        'access%255Ftoken': 'nested-secret',
        'api%25255Fkey': 'nested-secret',
        'bad%ZZ%5Fapi%5Fkey': 'nested-secret',
        '%255F%255Fproto%255F%255F': { polluted: 'nested' },
        'constr%2575ctor': { polluted: 'nested' },
        'bad%E2%80%AEkey': 'hidden',
        'display%5Fname': 'keep-nested',
      },
    }), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.deepEqual(loaded.extra, {
      'display%5Fname': 'keep-top',
      future: { keep: true, 'display%5Fname': 'keep-nested' },
    });
    assert.equal(({} as { polluted?: string }).polluted, undefined);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('loading never throws: absent → null, corrupt → null, hostile shapes normalize', () => {
  const ws = tmpWorkspace();
  try {
    assert.equal(loadWorkspaceManifest(ws), null, 'absent manifest');

    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), '{not json', 'utf8');
    assert.equal(loadWorkspaceManifest(ws), null, 'corrupt JSON');

    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      profile: 'astrology', // unknown → custom
      name: 42, // wrong type → default
      agents: 'nope', // wrong shape → defaults
      skills: { enabled: ['ok', 7, null, 'also-ok'] }, // junk filtered
      onboarded: { by: 'aliens' }, // unknown source → import
    }), 'utf8');
    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.equal(loaded.profile, 'custom');
    assert.equal(loaded.name, 'workspace');
    assert.deepEqual(loaded.agents, { default: '', enabled: [] });
    assert.deepEqual(loaded.capabilities, { enabled: [], disabled: [] });
    assert.deepEqual(loaded.skills.enabled, ['ok', 'also-ok']);
    assert.equal(loaded.onboarded.by, 'import');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('profile presets are self-consistent (every profile usable by the wizard)', () => {
  assert.ok(WORKSPACE_PROFILES.length >= 6);
  assert.equal(WORKSPACE_PROFILES.at(-1)!.id, 'custom', 'custom renders last in pickers');
  // Frontend is a task-scoped engineering capability, not a top-level profile or persona.
  assert.ok(!WORKSPACE_PROFILES.some((preset) => (preset.id as string) === 'frontend'));
  const engineering = WORKSPACE_PROFILES.find((preset) => preset.id === 'engineering')!;
  assert.deepEqual(engineering.agents, { default: 'engineer', enabled: ['engineer'] });
  assert.deepEqual(engineering.capabilities.enabled, ['frontend']);
  assert.ok(!engineering.tools.profiles.includes('design'), 'design is not a baseline engineering tool profile');
  for (const preset of WORKSPACE_PROFILES) {
    assert.ok(preset.label.trim().length > 0, `${preset.id}: label`);
    assert.ok(preset.description.trim().length > 0, `${preset.id}: description`);
    assert.equal(getWorkspaceProfile(preset.id), preset);
    if (preset.id !== 'custom') {
      assert.ok(preset.agents.default.length > 0, `${preset.id}: names a default persona`);
      assert.ok(preset.agents.enabled.includes(preset.agents.default), `${preset.id}: default persona is enabled`);
    }
  }
});

test('legacy frontend-builder manifests normalize to engineer plus the frontend capability', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      profile: 'engineering',
      agents: { default: 'frontend-builder', enabled: ['worker', 'frontend-builder', 'engineer'] },
      capabilities: { enabled: ['future-capability'], disabled: ['blocked-capability'] },
    }), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.equal(loaded.agents.default, 'engineer');
    assert.deepEqual(loaded.agents.enabled, ['worker', 'engineer']);
    assert.deepEqual(
      loaded.capabilities,
      { enabled: ['future-capability', 'frontend'], disabled: ['blocked-capability'] },
      'unknown capability ids survive legacy migration',
    );
    saveWorkspaceManifest(ws, loaded);
    assert.deepEqual(
      loadWorkspaceManifest(ws)?.capabilities,
      loaded.capabilities,
      'unknown capability ids survive a normalized save and reload',
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('capability normalization deduplicates ids and explicit disables win', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      profile: 'engineering',
      agents: { default: 'frontend-builder', enabled: ['frontend-builder'] },
      capabilities: {
        enabled: ['frontend', 'future-capability', 'future-capability'],
        disabled: ['frontend', 'blocked-capability', 'blocked-capability'],
      },
    }), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.deepEqual(loaded.capabilities, {
      enabled: ['future-capability'],
      disabled: ['frontend', 'blocked-capability'],
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('legacy frontend-builder default enables engineer even when the legacy enabled list is absent', () => {
  const ws = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(ws, '.brainrouter'), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(ws), JSON.stringify({
      profile: 'engineering',
      agents: { default: 'frontend-builder' },
    }), 'utf8');

    const loaded = loadWorkspaceManifest(ws);
    assert.ok(loaded);
    assert.deepEqual(loaded.agents, { default: 'engineer', enabled: ['engineer'] });
    assert.deepEqual(loaded.capabilities, { enabled: ['frontend'], disabled: [] });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest writers never emit the legacy frontend persona id', () => {
  const ws = tmpWorkspace();
  try {
    const manifest = createWorkspaceManifest({
      name: 'demo',
      profile: 'custom',
      by: 'wizard',
      overrides: {
        agents: { default: 'frontend-builder', enabled: ['frontend-builder'] },
      },
    });
    assert.deepEqual(manifest.agents, { default: 'engineer', enabled: ['engineer'] });
    assert.deepEqual(manifest.capabilities, { enabled: ['frontend'], disabled: [] });

    manifest.agents = { default: 'frontend-builder', enabled: ['frontend-builder'] };
    saveWorkspaceManifest(ws, manifest);
    const persisted = fs.readFileSync(workspaceManifestPath(ws), 'utf8');
    assert.ok(!persisted.includes('frontend-builder'));
    assert.deepEqual(loadWorkspaceManifest(ws)?.agents, { default: 'engineer', enabled: ['engineer'] });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
