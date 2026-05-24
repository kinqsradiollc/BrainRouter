import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getCliStateDir, getCliStateFile } from '../state/cliState.js';
import { appendTranscriptEntry, listTranscripts, readTranscriptEntries, redactText } from '../state/sessionStore.js';
import { formatPlan, readPlan, updatePlan } from '../state/taskStore.js';
import { ARTIFACT, artifactRelativePath, createWorkflow, getCurrentWorkflow, getWorkflowDir, listWorkflows, slugify } from '../state/workflowArtifacts.js';
import { addHook, readHooks, removeHook, runHooks, setHookEnabled } from '../state/hooksStore.js';
import { readPreferences, writePreferences } from '../state/preferencesStore.js';
import { withTempWorkspace } from './_helpers.js';

test('CLI state helpers live under ~/.brainrouter, not the workspace', () => {
  withTempWorkspace((workspace) => {
    const stateDir = getCliStateDir(workspace);
    const home = process.env.BRAINROUTER_HOME!;
    // CLI state lives at <home>/workspaces/<encoded>/cli — NOT in the workspace.
    assert.equal(stateDir.startsWith(path.join(fs.realpathSync(home), 'workspaces')), true);
    assert.equal(stateDir.endsWith(path.join('cli')), true);
    assert.equal(fs.existsSync(stateDir), true);
    // The workspace itself stays clean of personal CLI state.
    assert.equal(fs.existsSync(path.join(fs.realpathSync(workspace), '.brainrouter', 'cli')), false);
    assert.equal(getCliStateFile(workspace, 'tasks.json'), path.join(stateDir, 'tasks.json'));
    assert.throws(() => getCliStateFile(workspace, '../tasks.json'), /Invalid CLI state file name/);
  });
});

test('plan store persists and validates durable plan state', () => {
  withTempWorkspace((workspace) => {
    assert.deepEqual(readPlan(workspace).items, []);

    const state = updatePlan(workspace, {
      explanation: 'phase one',
      plan: [
        { step: 'Add state helpers', status: 'completed' },
        { step: 'Wire update_plan', status: 'in_progress' },
      ],
    });

    assert.equal(state.items.length, 2);
    assert.match(formatPlan(readPlan(workspace)), /\[\/\] Wire update_plan/);
    assert.throws(
      () => updatePlan(workspace, {
        plan: [
          { step: 'one', status: 'in_progress' },
          { step: 'two', status: 'in_progress' },
        ],
      }),
      /At most one plan item/,
    );
  });
});

test('transcript store redacts secrets and reads recent entries', () => {
  withTempWorkspace((workspace) => {
    assert.equal(redactText('OPENAI_API_KEY="sk-secretvalue123"'), 'OPENAI_API_KEY="[REDACTED]"');

    appendTranscriptEntry(workspace, 'session:one', {
      role: 'user',
      content: 'token br_secretvalue123 should be hidden',
    });
    const entries = readTranscriptEntries(workspace, 'session:one');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, 'token [REDACTED] should be hidden');
    assert.equal(typeof entries[0].timestamp, 'string');
  });
});

test('sessionStore: appendTranscriptEntry dedupes consecutive identical user prompts', async () => {
  const { appendTranscriptEntry, readTranscriptEntries } = await import('../state/sessionStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:dedup';
    appendTranscriptEntry(workspace, sk, { role: 'user', content: 'help me with X' });
    appendTranscriptEntry(workspace, sk, { role: 'user', content: 'help me with X' }); // dup — skip
    appendTranscriptEntry(workspace, sk, { role: 'assistant', content: 'sure!' });
    appendTranscriptEntry(workspace, sk, { role: 'user', content: 'help me with X' }); // not consecutive — keep
    const entries = readTranscriptEntries(workspace, sk, 100);
    const userEntries = entries.filter((e) => e.role === 'user');
    assert.equal(userEntries.length, 2, 'consecutive duplicate user prompts should collapse to one; non-consecutive duplicates are kept');
    assert.equal(entries.length, 3); // 1 user + 1 assistant + 1 user
  });
});

test('listTranscripts surfaces persisted sessions newest first with previews', () => {
  withTempWorkspace((workspace) => {
    appendTranscriptEntry(workspace, 'session:one', { role: 'user', content: 'first thing about Zod' });
    appendTranscriptEntry(workspace, 'session:one', { role: 'assistant', content: 'ok' });
    appendTranscriptEntry(workspace, 'session:two', { role: 'user', content: 'second different session' });
    const list = listTranscripts(workspace);
    assert.equal(list.length, 2);
    const one = list.find((t) => t.sessionKey === 'session:one')!;
    assert.equal(one.turnCount, 2);
    assert.match(one.firstUserMessage ?? '', /Zod/);
  });
});

test('workflowArtifacts: slugify produces safe URL-style slugs and rejects path traversal', () => {
  assert.equal(slugify('Spec-Driven Feature: Login (v2)'), 'spec-driven-feature-login-v2');
  assert.equal(slugify(''), 'workflow');
  assert.equal(slugify('../escape'), 'escape');
  assert.equal(slugify('A'.repeat(200)).length <= 60, true);
});

test('workflowArtifacts: createWorkflow writes meta.json and sets current pointer', () => {
  withTempWorkspace((workspace) => {
    const meta = createWorkflow(workspace, { title: 'Add auth', kind: 'feature-dev' });
    assert.equal(meta.slug, 'add-auth');
    assert.equal(meta.status, 'draft');
    assert.equal(getCurrentWorkflow(workspace), 'add-auth');
    const metaPath = path.join(getWorkflowDir(workspace, 'add-auth'), 'meta.json');
    assert.equal(fs.existsSync(metaPath), true);
    const stored = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(stored.title, 'Add auth');
  });
});

test('workflowArtifacts: artifactRelativePath stays inside workspace and listWorkflows includes every workflow', () => {
  withTempWorkspace((workspace) => {
    createWorkflow(workspace, { title: 'one', kind: 'spec' });
    createWorkflow(workspace, { title: 'two', kind: 'feature-dev' });
    const slugs = listWorkflows(workspace).map((w) => w.slug).sort();
    assert.deepEqual(slugs, ['one', 'two']);
    const rel = artifactRelativePath(workspace, 'two', ARTIFACT.spec);
    assert.equal(rel.split(path.sep).join('/').startsWith('.brainrouter/workflows/two/'), true);
    assert.equal(rel.endsWith('spec.md'), true);
    assert.equal(rel.includes('..'), false);
  });
});

test('workflowArtifacts: stay in the workspace so they can be committed', async () => {
  const { getWorkflowsRoot } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const root = getWorkflowsRoot(workspace);
    assert.equal(root, path.join(fs.realpathSync(workspace), '.brainrouter', 'workflows'));
    assert.equal(fs.existsSync(root), true);
  });
});

test('hooksStore: add → enable/disable → run → remove', () => {
  withTempWorkspace((workspace) => {
    assert.deepEqual(readHooks(workspace), []);
    const created = addHook(workspace, { event: 'post-tool', command: 'true' });
    assert.equal(readHooks(workspace).length, 1);
    const results = runHooks(workspace, 'post-tool', { tool: 'read_file' });
    assert.equal(results.length, 1);
    assert.equal(results[0].exitCode, 0);
    setHookEnabled(workspace, created.id, false);
    assert.equal(runHooks(workspace, 'post-tool', { tool: 'read_file' }).length, 0);
    assert.equal(removeHook(workspace, created.id), true);
    assert.deepEqual(readHooks(workspace), []);
  });
});

test('hooksStore: pre-tool hook with non-zero exit signals denial', () => {
  withTempWorkspace((workspace) => {
    addHook(workspace, { event: 'pre-tool', command: 'false' });
    const results = runHooks(workspace, 'pre-tool', { tool: 'run_command' });
    assert.equal(results.length, 1);
    assert.notEqual(results[0].exitCode, 0);
  });
});

test('preferencesStore round-trips autoReview, editorMode, and statusline', () => {
  withTempWorkspace((workspace) => {
    const defaults = readPreferences(workspace);
    assert.equal(defaults.autoReview, false);
    assert.equal(defaults.editorMode, 'emacs');
    assert.equal(defaults.statusline, 'mode');
    writePreferences(workspace, { autoReview: true, statusline: 'mode,branch,tokens' });
    const after = readPreferences(workspace);
    assert.equal(after.autoReview, true);
    assert.equal(after.statusline, 'mode,branch,tokens');
    assert.equal(after.editorMode, 'emacs'); // unchanged
  });
});

test('preferencesStore: defaults include theme + personality + statusline fields', () => {
  withTempWorkspace((workspace) => {
    const prefs = readPreferences(workspace);
    assert.equal(prefs.theme, 'auto');
    assert.equal(prefs.personality, 'standard');
    assert.equal(prefs.rawScrollback, false);
    assert.equal(prefs.experimental, false);
    assert.equal(prefs.memoriesEnabled, true);
  });
});

test('preferencesStore: writePreferences merges new theme/personality fields', () => {
  withTempWorkspace((workspace) => {
    writePreferences(workspace, { theme: 'dark', personality: 'concise' });
    const prefs = readPreferences(workspace);
    assert.equal(prefs.theme, 'dark');
    assert.equal(prefs.personality, 'concise');
    // Old defaults still present
    assert.equal(prefs.statusline, 'mode');
  });
});

test('hookifyStore: parse, create, list, toggle, delete roundtrip', async () => {
  const { createHookifyRule, listHookifyRules, toggleHookifyRule, deleteHookifyRule, parseHookifyFile, evaluateHookify, buildHookifyContext } = await import('../state/hookifyStore.js');
  withTempWorkspace((workspace) => {
    const rule = createHookifyRule(workspace, {
      name: 'block-rm-rf',
      event: 'bash',
      pattern: 'rm\\s+-rf',
      action: 'block',
      message: 'Dangerous rm detected. Verify path.',
    });
    assert.equal(rule.id, 'block-rm-rf');
    assert.equal(rule.action, 'block');
    assert.equal(rule.enabled, true);

    const parsed = parseHookifyFile(rule.sourcePath)!;
    assert.equal(parsed.pattern, 'rm\\s+-rf');

    const rules = listHookifyRules(workspace);
    assert.equal(rules.length, 1);

    const ctx = buildHookifyContext('run_command', { command: 'rm -rf /tmp/foo' });
    const matches = evaluateHookify(rules, ctx);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].action, 'block');

    const ctxSafe = buildHookifyContext('run_command', { command: 'ls /tmp' });
    assert.equal(evaluateHookify(rules, ctxSafe).length, 0);

    assert.equal(toggleHookifyRule(workspace, 'block-rm-rf', false), true);
    assert.equal(listHookifyRules(workspace)[0].enabled, false);

    assert.equal(deleteHookifyRule(workspace, 'block-rm-rf'), true);
    assert.equal(listHookifyRules(workspace).length, 0);
  });
});

test('hookifyStore: condition-based file event matches new_text and file_path', async () => {
  const { createHookifyRule, evaluateHookify, buildHookifyContext, listHookifyRules } = await import('../state/hookifyStore.js');
  withTempWorkspace((workspace) => {
    createHookifyRule(workspace, {
      name: 'no-console-log',
      event: 'file',
      action: 'warn',
      conditions: [
        { field: 'file_path', operator: 'regex_match', pattern: '\\.tsx?$' },
        { field: 'new_text', operator: 'contains', pattern: 'console.log' },
      ],
      message: 'console.log in TypeScript',
    });
    const rules = listHookifyRules(workspace);
    const hit = buildHookifyContext('write_file', { path: 'src/foo.ts', content: 'console.log("debug")' });
    assert.equal(evaluateHookify(rules, hit).length, 1);
    const miss = buildHookifyContext('write_file', { path: 'README.md', content: 'console.log("debug")' });
    assert.equal(evaluateHookify(rules, miss).length, 0);
  });
});

test('taskStore: per-session plans are isolated and updatePlan writes the bucket', async () => {
  const { getSessionStateDir } = await import('../state/cliState.js');
  withTempWorkspace((workspace) => {
    const sessionA = 'brainrouter-cli:project:main';
    const sessionB = 'brainrouter-cli:project:side';

    updatePlan(workspace, { plan: [{ step: 'do A1', status: 'in_progress' }] }, sessionA);
    updatePlan(workspace, { plan: [{ step: 'do B1', status: 'pending' }] }, sessionB);

    const planA = readPlan(workspace, sessionA);
    const planB = readPlan(workspace, sessionB);
    assert.equal(planA.items[0].step, 'do A1');
    assert.equal(planB.items[0].step, 'do B1');
    // File lives in the bucket folder.
    assert.equal(fs.existsSync(path.join(getSessionStateDir(workspace, sessionA), 'tasks.json')), true);
  });
});

test('sessionStore: transcripts land in sessions/<key>/transcript.jsonl', async () => {
  const { getSessionStateDir } = await import('../state/cliState.js');
  withTempWorkspace((workspace) => {
    appendTranscriptEntry(workspace, 'brainrouter-cli:project:main', { role: 'user', content: 'hi there' });
    const bucket = getSessionStateDir(workspace, 'brainrouter-cli:project:main');
    assert.equal(fs.existsSync(path.join(bucket, 'transcript.jsonl')), true);
    const entries = readTranscriptEntries(workspace, 'brainrouter-cli:project:main');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, 'hi there');
  });
});

test('sessionStore: legacy transcripts/<encoded>.jsonl remains discoverable', async () => {
  const { getCliStateDir, encodeSessionKey } = await import('../state/cliState.js');
  withTempWorkspace((workspace) => {
    const stateDir = getCliStateDir(workspace);
    const legacyDir = path.join(stateDir, 'transcripts');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyKey = 'legacy-session:abc';
    fs.writeFileSync(
      path.join(legacyDir, `${encodeSessionKey(legacyKey)}.jsonl`),
      JSON.stringify({ role: 'user', content: 'legacy hello', timestamp: '2026-01-01T00:00:00Z' }) + '\n',
    );

    // New layout entry for a different session.
    appendTranscriptEntry(workspace, 'new-session:xyz', { role: 'user', content: 'new hello' });

    const all = listTranscripts(workspace);
    const keys = all.map((s) => s.sessionKey).sort();
    assert.deepEqual(keys, ['legacy-session:abc', 'new-session:xyz']);

    // Reading by the legacy key still works.
    const legacyEntries = readTranscriptEntries(workspace, legacyKey);
    assert.equal(legacyEntries.length, 1);
    assert.equal(legacyEntries[0].content, 'legacy hello');
  });
});

test('cliState: migration neutralizes the legacy <workspace>/.brainrouter (preserves workflows/)', async () => {
  const { getCliStateDir } = await import('../state/cliState.js');
  withTempWorkspace((workspace) => {
    const legacy = path.join(workspace, '.brainrouter');
    fs.mkdirSync(path.join(legacy, 'cli'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'workflows', 'feat-x'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'cli', 'tasks.json'), JSON.stringify({ items: [] }));
    fs.writeFileSync(path.join(legacy, 'workflows', 'feat-x', 'spec.md'), '# Committable spec');

    getCliStateDir(workspace); // triggers migration

    // Legacy cli/ and hooks/ archived; workflows/ kept in workspace.
    assert.equal(fs.existsSync(path.join(legacy, 'cli')), false);
    assert.equal(fs.existsSync(path.join(legacy, 'hooks')), false);
    assert.equal(fs.existsSync(path.join(legacy, 'workflows', 'feat-x', 'spec.md')), true);
    assert.equal(fs.existsSync(path.join(workspace, '.brainrouter.migrated', 'cli', 'tasks.json')), true);
  });
});

test('cliState: BRAINROUTER_HOME pins the user-global state root', async () => {
  const { getBrainrouterHome, getWorkspaceStateRoot } = await import('../state/cliState.js');
  withTempWorkspace((workspace) => {
    const home = process.env.BRAINROUTER_HOME!;
    assert.equal(getBrainrouterHome(), fs.realpathSync(home));
    const wsRoot = getWorkspaceStateRoot(workspace);
    assert.equal(wsRoot.startsWith(path.join(fs.realpathSync(home), 'workspaces')), true);
    // Encoded directory should include the workspace basename and an 8-char hash.
    const tail = path.basename(wsRoot);
    assert.match(tail, /-[0-9a-f]{8}$/);
  });
});

test('cliState: legacy <workspace>/.brainrouter/ migrates to the user home on first use', async () => {
  const { getCliStateDir } = await import('../state/cliState.js');
  withTempWorkspace((workspace) => {
    // Plant legacy files inside the workspace as if they came from an older build.
    const legacyDir = path.join(workspace, '.brainrouter', 'cli');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'tasks.json'), JSON.stringify({ items: [{ step: 'legacy', status: 'pending' }] }));
    fs.writeFileSync(path.join(legacyDir, 'goal.json'), JSON.stringify({ text: 'old goal', setAt: '2026-01-01T00:00:00Z' }));

    const newDir = getCliStateDir(workspace);
    // Migrated files now exist in the user-home location.
    assert.equal(fs.existsSync(path.join(newDir, 'tasks.json')), true);
    assert.equal(fs.existsSync(path.join(newDir, 'goal.json')), true);
    // Migration marker is dropped.
    assert.equal(fs.existsSync(path.join(path.dirname(newDir), '.migrated-from-workspace')), true);
    // Second call is a no-op (idempotent — files already present, marker stays).
    getCliStateDir(workspace);
  });
});

test('cliState: listSessionDirs surfaces every session bucket newest first', async () => {
  const { listSessionDirs } = await import('../state/cliState.js');
  withTempWorkspace((workspace) => {
    appendTranscriptEntry(workspace, 'sess:a', { role: 'user', content: 'A' });
    appendTranscriptEntry(workspace, 'sess:b', { role: 'user', content: 'B' });
    const dirs = listSessionDirs(workspace);
    const keys = dirs.map((d) => d.sessionKey).sort();
    assert.deepEqual(keys, ['sess:a', 'sess:b']);
    for (const d of dirs) {
      assert.equal(fs.existsSync(d.dir), true);
    }
  });
});
