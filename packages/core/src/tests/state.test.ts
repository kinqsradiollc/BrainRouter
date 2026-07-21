import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getStateDir, getStateFile } from '../storage/store.js';
import { appendTranscriptEntry, listTranscripts, readTranscriptEntries, redactText } from '../session/transcript/sessionStore.js';
import { formatPlan, readPlan, updatePlan, seedPlanFromRequirement } from '../task/taskStore.js';
import { ARTIFACT, artifactRelativePath, createWorkflow, getCurrentWorkflow, getWorkflowDir, listWorkflows, slugify } from '../workflow/run/workflowArtifacts.js';
import { addHook, readHooks, removeHook, runHooks, setHookEnabled } from '../hooks/hooksStore.js';
import { applyYoloOff, applyYoloOn, readPreferences, writePreferences, normalizeEffort } from '../session/preferences/preferencesStore.js';
import { withTempWorkspace } from './_helpers.js';
import { _resetCliKnobsCache, setCliKnobOverride } from '../config/config.js';

test('CLI state helpers live under ~/.brainrouter, not the workspace', () => {
  withTempWorkspace((workspace) => {
    const stateDir = getStateDir(workspace);
    const home = process.env.BRAINROUTER_HOME!;
    // CLI state lives at <home>/workspaces/<encoded>/cli — NOT in the workspace.
    assert.equal(stateDir.startsWith(path.join(fs.realpathSync(home), 'workspaces')), true);
    assert.equal(stateDir.endsWith(path.join('cli')), true);
    assert.equal(fs.existsSync(stateDir), true);
    // The workspace itself stays clean of personal CLI state.
    assert.equal(fs.existsSync(path.join(fs.realpathSync(workspace), '.brainrouter', 'cli')), false);
    assert.equal(getStateFile(workspace, 'tasks.json'), path.join(stateDir, 'tasks.json'));
    assert.throws(() => getStateFile(workspace, '../tasks.json'), /Invalid CLI state file name/);
  });
});

test('seedPlanFromRequirement anchors a plan to a requirement and updatePlan preserves the anchor', () => {
  withTempWorkspace((workspace) => {
    const sessionKey = 'sess-req';
    const seeded = seedPlanFromRequirement(
      workspace,
      { id: 'req_abc12345', acceptanceCriteria: ['handles empty input', 'returns 200 on success'] },
      sessionKey,
    );
    // one pending item per criterion, anchored to the requirement
    assert.equal(seeded.requirementId, 'req_abc12345');
    assert.deepEqual(seeded.items.map((i) => i.step), ['handles empty input', 'returns 200 on success']);
    assert.ok(seeded.items.every((i) => i.status === 'pending'));
    assert.equal(readPlan(workspace, sessionKey).requirementId, 'req_abc12345');

    // a routine update_plan (no requirementId) must NOT drop the anchor
    const edited = updatePlan(workspace, { plan: [{ step: 'handles empty input', status: 'completed' }] }, sessionKey);
    assert.equal(edited.requirementId, 'req_abc12345');

    // the anchor is per-session: a different session's plan is independent
    assert.equal(readPlan(workspace, 'other-session').requirementId, undefined);
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
  const { appendTranscriptEntry, readTranscriptEntries } = await import('../session/transcript/sessionStore.js');
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

test('listTranscripts limit returns the newest page without changing ordering', () => {
  withTempWorkspace((workspace) => {
    appendTranscriptEntry(workspace, 'session:a', { role: 'user', content: 'first session' });
    appendTranscriptEntry(workspace, 'session:b', { role: 'user', content: 'second session' });
    appendTranscriptEntry(workspace, 'session:c', { role: 'user', content: 'third session' });
    const all = listTranscripts(workspace);
    const limited = listTranscripts(workspace, { limit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(limited[0].sessionKey, all[0].sessionKey);
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
  const { getWorkflowsRoot } = await import('../workflow/run/workflowArtifacts.js');
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

test('preferencesStore: executionMode + reviewPolicy default to planning + request', () => {
  withTempWorkspace((workspace) => {
    const prefs = readPreferences(workspace);
    assert.equal(prefs.executionMode, 'planning');
    assert.equal(prefs.reviewPolicy, 'request');
  });
});

test('preferencesStore: executionMode + reviewPolicy round-trip through write+read', () => {
  withTempWorkspace((workspace) => {
    writePreferences(workspace, { executionMode: 'fast', reviewPolicy: 'proceed' });
    const after = readPreferences(workspace);
    assert.equal(after.executionMode, 'fast');
    assert.equal(after.reviewPolicy, 'proceed');
    // Independent: flipping only one does not silently flip the other.
    writePreferences(workspace, { executionMode: 'planning' });
    const partial = readPreferences(workspace);
    assert.equal(partial.executionMode, 'planning');
    assert.equal(partial.reviewPolicy, 'proceed');
  });
});

test('preferencesStore: applyYoloOn flips both new fields; applyYoloOff restores defaults', () => {
  withTempWorkspace((workspace) => {
    const on = applyYoloOn(workspace);
    assert.equal(on.executionMode, 'fast');
    assert.equal(on.reviewPolicy, 'proceed');
    assert.equal(on.autoApproveShell, true, 'legacy mirror stays in sync during alias period');
    // Read-back returns the same values (no migration drift).
    const reread = readPreferences(workspace);
    assert.equal(reread.executionMode, 'fast');
    assert.equal(reread.reviewPolicy, 'proceed');
    const off = applyYoloOff(workspace);
    assert.equal(off.executionMode, 'planning');
    assert.equal(off.reviewPolicy, 'request');
    assert.equal(off.autoApproveShell, false);
  });
});

test('preferencesStore: legacy autoApproveShell=true back-fills executionMode=fast + reviewPolicy=proceed', () => {
  withTempWorkspace((workspace) => {
    // Simulate an older install: only the legacy field is on disk, the new
    // fields are entirely absent (not just `undefined` in the in-memory
    // default).
    fs.writeFileSync(
      getStateFile(workspace, 'preferences.json'),
      JSON.stringify({ autoApproveShell: true }),
      'utf8',
    );
    const prefs = readPreferences(workspace);
    assert.equal(prefs.executionMode, 'fast');
    assert.equal(prefs.reviewPolicy, 'proceed');
    // Legacy field is untouched on disk — other readers still see it.
    const raw = JSON.parse(fs.readFileSync(getStateFile(workspace, 'preferences.json'), 'utf8'));
    assert.equal(raw.autoApproveShell, true);
  });
});

test('preferencesStore: legacy autoApproveShell=false reads back as defaults', () => {
  withTempWorkspace((workspace) => {
    fs.writeFileSync(
      getStateFile(workspace, 'preferences.json'),
      JSON.stringify({ autoApproveShell: false }),
      'utf8',
    );
    const prefs = readPreferences(workspace);
    assert.equal(prefs.executionMode, 'planning');
    assert.equal(prefs.reviewPolicy, 'request');
  });
});

test('preferencesStore: explicit new fields override the legacy migration', () => {
  withTempWorkspace((workspace) => {
    // User had /yolo on (autoApproveShell:true) then toggled /mode planning
    // explicitly. The new field must win — migration must not clobber it.
    fs.writeFileSync(
      getStateFile(workspace, 'preferences.json'),
      JSON.stringify({ autoApproveShell: true, executionMode: 'planning' }),
      'utf8',
    );
    const prefs = readPreferences(workspace);
    assert.equal(prefs.executionMode, 'planning');
    // reviewPolicy was unset on disk, so it falls back to default rather
    // than being driven by the legacy flag (the user already migrated).
    assert.equal(prefs.reviewPolicy, 'request');
  });
});

test('preferencesStore: effort defaults to medium and round-trips through write+read', () => {
  withTempWorkspace((workspace) => {
    const defaults = readPreferences(workspace);
    assert.equal(defaults.effort, 'medium');
    writePreferences(workspace, { effort: 'high' });
    assert.equal(readPreferences(workspace).effort, 'high');
    writePreferences(workspace, { effort: 'low' });
    assert.equal(readPreferences(workspace).effort, 'low');
  });
});

test('normalizeEffort: canonical API levels pass through exactly; legacy ultracode fails closed', () => {
  assert.equal(normalizeEffort('none'), 'none');
  assert.equal(normalizeEffort('minimal'), 'minimal');
  assert.equal(normalizeEffort('low'), 'low');
  assert.equal(normalizeEffort('medium'), 'medium');
  assert.equal(normalizeEffort('high'), 'high');
  // xhigh must pass through (previously dropped to undefined → resolveEffort fell back to medium).
  assert.equal(normalizeEffort('xhigh'), 'xhigh');
  assert.equal(normalizeEffort('max'), 'max');
  assert.equal(normalizeEffort('  MAX  '), 'max');
  assert.equal(normalizeEffort('ultracode'), undefined);
  assert.equal(normalizeEffort('Ultracode'), undefined);
  assert.equal(normalizeEffort('XHigh'), 'xhigh');
  // unknown / non-string → undefined
  assert.equal(normalizeEffort('turbo'), undefined);
  assert.equal(normalizeEffort(42), undefined);
});

test('resolveEffort: cli.effort > preference > default', async () => {
  const { resolveEffort } = await import('../session/preferences/preferencesStore.js');
  withTempWorkspace((workspace) => {
    try {
      // Default (no config knob, no pref) → medium.
      _resetCliKnobsCache();
      assert.deepEqual(resolveEffort(workspace), { effort: 'medium', source: 'default' });

      // Preference wins when cli.effort is unset.
      writePreferences(workspace, { effort: 'low' });
      assert.deepEqual(resolveEffort(workspace), { effort: 'low', source: 'preference' });

      // `cli.effort` beats preference even when preference disagrees.
      setCliKnobOverride({ effort: 'high' });
      assert.deepEqual(resolveEffort(workspace), { effort: 'high', source: 'config' });
    } finally {
      _resetCliKnobsCache();
    }
  });
});

test('hookifyStore: parse, create, list, toggle, delete roundtrip', async () => {
  const { createHookifyRule, listHookifyRules, toggleHookifyRule, deleteHookifyRule, parseHookifyFile, evaluateHookify, buildHookifyContext } = await import('../hooks/hookifyStore.js');
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
  const { createHookifyRule, evaluateHookify, buildHookifyContext, listHookifyRules } = await import('../hooks/hookifyStore.js');
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
  const { getSessionStateDir } = await import('../storage/store.js');
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
  const { getSessionStateDir } = await import('../storage/store.js');
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
  const { getStateDir, encodeSessionKey } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateDir = getStateDir(workspace);
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

test('cliState: migration neutralizes the legacy <workspace>/.brainrouter (rescues to home, deletes in place, no archive)', async () => {
  const { getStateDir, getWorkspaceStateRoot } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const legacy = path.join(workspace, '.brainrouter');
    fs.mkdirSync(path.join(legacy, 'cli'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'workflows', 'feat-x'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'cli', 'tasks.json'), JSON.stringify({ items: [] }));
    fs.writeFileSync(path.join(legacy, 'workflows', 'feat-x', 'spec.md'), '# Committable spec');
    const manifestBytes = '{\n  "version": 2,\n  "name": "keep-byte-for-byte"\n}\n';
    fs.writeFileSync(path.join(legacy, 'workspace.json'), manifestBytes);
    fs.writeFileSync(path.join(legacy, 'future-project-artifact.json'), '{"keep":true}\n');

    getStateDir(workspace); // triggers migration

    // Personal state is deleted in place; every other project artifact is
    // preserved by default so future committable types need no allowlist.
    assert.equal(fs.existsSync(path.join(legacy, 'cli')), false);
    assert.equal(fs.existsSync(path.join(legacy, 'hooks')), false);
    assert.equal(fs.existsSync(path.join(legacy, 'workflows', 'feat-x', 'spec.md')), true);
    assert.equal(fs.readFileSync(path.join(legacy, 'workspace.json'), 'utf8'), manifestBytes);
    assert.equal(fs.readFileSync(path.join(legacy, 'future-project-artifact.json'), 'utf8'), '{"keep":true}\n');
    // The rescued state lives in the user-global home, NOT in an in-workspace archive.
    const home = getWorkspaceStateRoot(workspace);
    assert.equal(fs.existsSync(path.join(home, 'cli', 'tasks.json')), true);
    // No `.brainrouter.migrated` archive is ever created in the project tree.
    assert.equal(fs.existsSync(path.join(workspace, '.brainrouter.migrated')), false);
  });
});

test('cliState: migration never follows a symlinked workspace-local .brainrouter directory', { skip: process.platform === 'win32' }, async () => {
  const { getStateDir } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-external-state-'));
    try {
      fs.mkdirSync(path.join(external, 'cli'), { recursive: true });
      const sentinel = path.join(external, 'cli', 'sentinel.json');
      fs.writeFileSync(sentinel, '{"keep":true}\n');
      fs.symlinkSync(external, path.join(workspace, '.brainrouter'));

      getStateDir(workspace);

      assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"keep":true}\n');
      assert.equal(fs.lstatSync(path.join(workspace, '.brainrouter')).isSymbolicLink(), true);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});

test('cliState: a prior migration marker does not discard newly reintroduced legacy state', async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateRoot = getWorkspaceStateRoot(workspace);
    fs.writeFileSync(path.join(stateRoot, '.migrated-from-workspace'), 'older migration\n');
    const legacyFile = path.join(workspace, '.brainrouter', 'cli', 'new-from-older-version.json');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, '{"fresh":true}\n');

    _resetLegacyWorkspaceMigrationForTests(workspace);
    const stateDir = getStateDir(workspace);

    assert.equal(fs.readFileSync(path.join(stateDir, 'new-from-older-version.json'), 'utf8'), '{"fresh":true}\n');
    assert.equal(fs.existsSync(path.join(workspace, '.brainrouter', 'cli')), false);
  });
});

test('cliState: differing destination collisions preserve both legacy and global bytes', async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateRoot = getWorkspaceStateRoot(workspace);
    const destination = path.join(stateRoot, 'cli', 'tasks.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, '{"version":"global"}\n');
    const source = path.join(workspace, '.brainrouter', 'cli', 'tasks.json');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, '{"version":"legacy"}\n');

    _resetLegacyWorkspaceMigrationForTests(workspace);
    getStateDir(workspace);

    assert.equal(fs.readFileSync(source, 'utf8'), '{"version":"legacy"}\n');
    assert.equal(fs.readFileSync(destination, 'utf8'), '{"version":"global"}\n');
    assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), false);
  });
});

test('cliState: byte-equivalent destination collisions permit verified source cleanup', async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const bytes = '{"same":true}\n';
    const stateRoot = getWorkspaceStateRoot(workspace);
    const destination = path.join(stateRoot, 'cli', 'tasks.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    const sourceRoot = path.join(workspace, '.brainrouter', 'cli');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'tasks.json'), bytes);

    _resetLegacyWorkspaceMigrationForTests(workspace);
    getStateDir(workspace);

    assert.equal(fs.existsSync(sourceRoot), false);
    assert.equal(fs.readFileSync(destination, 'utf8'), bytes);
    assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), true);
  });
});

test('cliState: byte-equivalent collisions with different modes preserve both files', { skip: process.platform === 'win32' }, async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const bytes = '{"same":true}\n';
    const stateRoot = getWorkspaceStateRoot(workspace);
    const destination = path.join(stateRoot, 'cli', 'tasks.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { mode: 0o644 });
    fs.chmodSync(destination, 0o644);
    const source = path.join(workspace, '.brainrouter', 'cli', 'tasks.json');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, bytes, { mode: 0o600 });
    fs.chmodSync(source, 0o600);

    _resetLegacyWorkspaceMigrationForTests(workspace);
    getStateDir(workspace);

    assert.equal(fs.readFileSync(source, 'utf8'), bytes);
    assert.equal(fs.statSync(source).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(destination, 'utf8'), bytes);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o644);
    assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), false);
  });
});

test('cliState: migration preserves an unowned source quarantine after interruption', async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateRoot = getWorkspaceStateRoot(workspace);
    const quarantine = path.join(
      workspace,
      '.brainrouter',
      '.cli.migration-source.123.0123456789abcdef01234567',
    );
    fs.mkdirSync(quarantine, { recursive: true });
    fs.writeFileSync(path.join(quarantine, 'tasks.json'), '{"interrupted":true}\n');

    _resetLegacyWorkspaceMigrationForTests(workspace);
    getStateDir(workspace);

    assert.equal(fs.readFileSync(path.join(quarantine, 'tasks.json'), 'utf8'), '{"interrupted":true}\n');
    assert.equal(fs.existsSync(path.join(stateRoot, 'cli', 'tasks.json')), false);
    assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), false);
  });
});

test('cliState: migration preserves an unowned cleanup tombstone after interruption', async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const cleanupTombstone = path.join(
      workspace,
      '.brainrouter',
      '.cli.migration-cleanup.123.0123456789abcdef01234567',
    );
    fs.mkdirSync(cleanupTombstone, { recursive: true });
    fs.writeFileSync(path.join(cleanupTombstone, 'tasks.json'), '{"cleanup":"interrupted"}\n');

    _resetLegacyWorkspaceMigrationForTests(workspace);
    const stateRoot = getWorkspaceStateRoot(workspace);
    _resetLegacyWorkspaceMigrationForTests(workspace);
    getStateDir(workspace);

    assert.equal(fs.readFileSync(path.join(cleanupTombstone, 'tasks.json'), 'utf8'), '{"cleanup":"interrupted"}\n');
    assert.equal(fs.existsSync(path.join(stateRoot, 'cli', 'tasks.json')), false);
    assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), false);
  });
});

test('cliState: a trusted receipt resumes an interrupted source quarantine', async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateRoot = getWorkspaceStateRoot(workspace);
    const source = path.join(fs.realpathSync(workspace), '.brainrouter', 'cli');
    const token = '2147483647.0123456789abcdef01234567';
    const quarantine = path.join(
      path.dirname(source),
      `.cli.migration-source.${token}`,
    );
    fs.mkdirSync(quarantine, { recursive: true });
    fs.writeFileSync(path.join(quarantine, 'tasks.json'), '{"crash":"recover"}\n');
    const expected = fs.lstatSync(quarantine);
    const destination = path.join(stateRoot, 'cli');
    const receiptPath = path.join(stateRoot, `.cli.legacy-migration.${token}.json`);
    fs.writeFileSync(receiptPath, `${JSON.stringify({
      version: 1,
      phase: 'prepared',
      source,
      destination,
      token,
      candidates: [quarantine],
      expected: {
        mode: expected.mode & 0o777,
        dev: expected.dev,
        ino: expected.ino,
      },
    })}\n`);

    _resetLegacyWorkspaceMigrationForTests(workspace);
    const stateDir = getStateDir(workspace);

    assert.equal(fs.readFileSync(path.join(stateDir, 'tasks.json'), 'utf8'), '{"crash":"recover"}\n');
    assert.equal(fs.existsSync(quarantine), false);
    assert.equal(fs.existsSync(receiptPath), false);
  });
});

test('cliState: a rename loser receipt cannot block recovery or later migration', async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateRoot = getWorkspaceStateRoot(workspace);
    const source = path.join(fs.realpathSync(workspace), '.brainrouter', 'cli');
    const destination = path.join(stateRoot, 'cli');
    const winnerToken = '2147483647.0123456789abcdef01234567';
    const loserToken = '2147483647.1123456789abcdef01234567';
    const winnerQuarantine = path.join(
      path.dirname(source),
      `.cli.migration-source.${winnerToken}`,
    );
    const loserQuarantine = path.join(
      path.dirname(source),
      `.cli.migration-source.${loserToken}`,
    );
    fs.mkdirSync(winnerQuarantine, { recursive: true });
    fs.writeFileSync(path.join(winnerQuarantine, 'old.json'), '{"generation":"old"}\n');
    const expected = fs.lstatSync(winnerQuarantine);

    const receiptValue = (token: string, candidate: string) => ({
      version: 1,
      phase: 'prepared',
      source,
      destination,
      token,
      candidates: [candidate],
      expected: {
        mode: expected.mode & 0o777,
        dev: expected.dev,
        ino: expected.ino,
      },
    });
    const winnerReceipt = path.join(
      stateRoot,
      `.cli.legacy-migration.${winnerToken}.json`,
    );
    const loserReceipt = path.join(
      stateRoot,
      `.cli.legacy-migration.${loserToken}.json`,
    );
    fs.writeFileSync(
      winnerReceipt,
      `${JSON.stringify(receiptValue(winnerToken, winnerQuarantine))}\n`,
    );
    fs.writeFileSync(
      loserReceipt,
      `${JSON.stringify(receiptValue(loserToken, loserQuarantine))}\n`,
    );

    _resetLegacyWorkspaceMigrationForTests(workspace);
    const stateDir = getStateDir(workspace);

    assert.equal(
      fs.readFileSync(path.join(stateDir, 'old.json'), 'utf8'),
      '{"generation":"old"}\n',
    );
    assert.equal(fs.existsSync(winnerQuarantine), false);
    assert.equal(fs.existsSync(winnerReceipt), false);
    assert.equal(fs.existsSync(loserReceipt), false);

    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'new.json'), '{"generation":"new"}\n');
    _resetLegacyWorkspaceMigrationForTests(workspace);
    getStateDir(workspace);

    assert.equal(fs.existsSync(source), false);
    assert.equal(
      fs.readFileSync(path.join(stateDir, 'new.json'), 'utf8'),
      '{"generation":"new"}\n',
    );
  });
});

test('cliState: dead receipt rescues its old candidate without consuming a recreated source', async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateRoot = getWorkspaceStateRoot(workspace);
    const source = path.join(fs.realpathSync(workspace), '.brainrouter', 'cli');
    const token = '2147483647.1123456789abcdef01234567';
    const quarantine = path.join(path.dirname(source), `.cli.migration-source.${token}`);
    fs.mkdirSync(quarantine, { recursive: true });
    fs.writeFileSync(path.join(quarantine, 'old.json'), '{"generation":"old"}\n');
    const expected = fs.lstatSync(quarantine);
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'new.json'), '{"generation":"new"}\n');
    const destination = path.join(stateRoot, 'cli');
    const receiptPath = path.join(stateRoot, `.cli.legacy-migration.${token}.json`);
    fs.writeFileSync(receiptPath, `${JSON.stringify({
      version: 1,
      phase: 'prepared',
      source,
      destination,
      token,
      candidates: [quarantine],
      expected: {
        mode: expected.mode & 0o777,
        dev: expected.dev,
        ino: expected.ino,
      },
    })}\n`);

    _resetLegacyWorkspaceMigrationForTests(workspace);
    const stateDir = getStateDir(workspace);
    assert.equal(fs.readFileSync(path.join(stateDir, 'old.json'), 'utf8'), '{"generation":"old"}\n');
    assert.equal(fs.readFileSync(path.join(source, 'new.json'), 'utf8'), '{"generation":"new"}\n');
    assert.equal(fs.existsSync(quarantine), false);
    assert.equal(fs.existsSync(receiptPath), false);
    assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), false);

    _resetLegacyWorkspaceMigrationForTests(workspace);
    getStateDir(workspace);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(path.join(stateDir, 'new.json'), 'utf8'), '{"generation":"new"}\n');
  });
});

test('cliState: cleanup-ready receipt is retired after a crash following source deletion', async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    _setLegacyWorkspaceMigrationHookForTests,
    getStateDir,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const source = path.join(fs.realpathSync(workspace), '.brainrouter', 'cli');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'tasks.json'), '{"cleanup":"durable"}\n');
    let interrupted = false;
    _setLegacyWorkspaceMigrationHookForTests((event) => {
      if (!interrupted && event.stage === 'after-cleanup-removal' && event.source === source) {
        interrupted = true;
        throw new Error('simulated crash after cleanup removal');
      }
    });

    try {
      const stateDir = getStateDir(workspace);
      const stateRoot = path.dirname(stateDir);
      assert.equal(interrupted, true);
      assert.equal(fs.readFileSync(path.join(stateDir, 'tasks.json'), 'utf8'), '{"cleanup":"durable"}\n');
      assert.equal(fs.existsSync(source), false);
      assert.equal(
        fs.readdirSync(stateRoot).some((name) => name.includes('.legacy-migration.')),
        true,
      );

      _setLegacyWorkspaceMigrationHookForTests(undefined);
      _resetLegacyWorkspaceMigrationForTests(workspace);
      getStateDir(workspace);
      assert.equal(
        fs.readdirSync(stateRoot).some((name) => name.includes('.legacy-migration.')),
        false,
      );
    } finally {
      _setLegacyWorkspaceMigrationHookForTests(undefined);
    }
  });
});

test('cliState: near-miss receipt names never authorize quarantine cleanup', async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateRoot = getWorkspaceStateRoot(workspace);
    const source = path.join(fs.realpathSync(workspace), '.brainrouter', 'cli');
    const token = '2147483647.0123456789abcdef01234567';
    const quarantine = path.join(path.dirname(source), `.cli.migration-source.${token}`);
    fs.mkdirSync(quarantine, { recursive: true });
    fs.writeFileSync(path.join(quarantine, 'tasks.json'), '{"keep":true}\n');
    const expected = fs.lstatSync(quarantine);
    const nearMiss = path.join(stateRoot, `XcliYlegacy-migrationZ${token}Qjson`);
    fs.writeFileSync(nearMiss, `${JSON.stringify({
      version: 1,
      phase: 'prepared',
      source,
      destination: path.join(stateRoot, 'cli'),
      token,
      candidates: [quarantine],
      expected: { mode: expected.mode & 0o777, dev: expected.dev, ino: expected.ino },
    })}\n`);

    _resetLegacyWorkspaceMigrationForTests(workspace);
    getStateDir(workspace);

    assert.equal(fs.readFileSync(path.join(quarantine, 'tasks.json'), 'utf8'), '{"keep":true}\n');
    assert.equal(fs.existsSync(nearMiss), true);
  });
});

test('cliState: migration refuses a workspace parent swapped to a symlink', { skip: process.platform === 'win32' }, async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    _setLegacyWorkspaceMigrationHookForTests,
    getStateDir,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const root = fs.realpathSync(workspace);
    const legacyRoot = path.join(root, '.brainrouter');
    const source = path.join(legacyRoot, 'cli');
    const displacedRoot = `${legacyRoot}.displaced`;
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'br-legacy-parent-external-'));
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'tasks.json'), '{"owned":"legacy"}\n');
    let swapped = false;
    _setLegacyWorkspaceMigrationHookForTests((event) => {
      if (swapped || event.stage !== 'before-quarantine' || event.source !== source) return;
      swapped = true;
      fs.renameSync(legacyRoot, displacedRoot);
      fs.symlinkSync(external, legacyRoot);
    });

    try {
      getStateDir(workspace);
      assert.equal(swapped, true);
      assert.equal(fs.existsSync(path.join(external, 'cli')), false);
      assert.equal(
        fs.readFileSync(path.join(displacedRoot, 'cli', 'tasks.json'), 'utf8'),
        '{"owned":"legacy"}\n',
      );
    } finally {
      _setLegacyWorkspaceMigrationHookForTests(undefined);
      if (fs.lstatSync(legacyRoot).isSymbolicLink()) fs.unlinkSync(legacyRoot);
      fs.renameSync(displacedRoot, legacyRoot);
      _resetLegacyWorkspaceMigrationForTests(workspace);
      getStateDir(workspace);
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});

test('cliState: a canonical source recreated after quarantine survives for the next migration', async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    _setLegacyWorkspaceMigrationHookForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const sourceRoot = path.join(fs.realpathSync(workspace), '.brainrouter', 'cli');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'old.json'), '{"generation":"old"}\n');
    let raced = false;
    _setLegacyWorkspaceMigrationHookForTests((event) => {
      if (raced || event.stage !== 'after-quarantine' || event.source !== sourceRoot) return;
      raced = true;
      fs.mkdirSync(sourceRoot);
      fs.writeFileSync(path.join(sourceRoot, 'new.json'), '{"generation":"new"}\n');
    });

    try {
      const stateDir = getStateDir(workspace);
      const stateRoot = getWorkspaceStateRoot(workspace);
      assert.equal(fs.readFileSync(path.join(stateDir, 'old.json'), 'utf8'), '{"generation":"old"}\n');
      assert.equal(fs.readFileSync(path.join(sourceRoot, 'new.json'), 'utf8'), '{"generation":"new"}\n');
      assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), false);

      _setLegacyWorkspaceMigrationHookForTests(undefined);
      _resetLegacyWorkspaceMigrationForTests(workspace);
      getStateDir(workspace);

      assert.equal(fs.existsSync(sourceRoot), false);
      assert.equal(fs.readFileSync(path.join(stateDir, 'new.json'), 'utf8'), '{"generation":"new"}\n');
      assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), true);
    } finally {
      _setLegacyWorkspaceMigrationHookForTests(undefined);
    }
  });
});

test('cliState: cleanup preserves a quarantined version changed after rescue', async () => {
  const {
    _setLegacyWorkspaceMigrationHookForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const sourceRoot = path.join(fs.realpathSync(workspace), '.brainrouter', 'cli');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'tasks.json'), '{"version":1}\n');
    let changed = false;
    _setLegacyWorkspaceMigrationHookForTests((event) => {
      if (changed || event.stage !== 'before-quarantine-cleanup' || event.source !== sourceRoot) return;
      changed = true;
      fs.writeFileSync(path.join(event.quarantine, 'tasks.json'), '{"version":2}\n');
    });

    try {
      const stateDir = getStateDir(workspace);
      const stateRoot = getWorkspaceStateRoot(workspace);
      assert.equal(fs.readFileSync(path.join(stateDir, 'tasks.json'), 'utf8'), '{"version":1}\n');
      assert.equal(fs.readFileSync(path.join(sourceRoot, 'tasks.json'), 'utf8'), '{"version":2}\n');
      assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), false);
    } finally {
      _setLegacyWorkspaceMigrationHookForTests(undefined);
    }
  });
});

test('cliState: cleanup never deletes a replacement swapped onto its tombstone path', async () => {
  const {
    _setLegacyWorkspaceMigrationHookForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const sourceRoot = path.join(fs.realpathSync(workspace), '.brainrouter', 'cli');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'tasks.json'), '{"owned":"legacy"}\n');
    let cleanupTombstone: string | undefined;
    let displacedOwnedSource: string | undefined;
    _setLegacyWorkspaceMigrationHookForTests((event) => {
      if (cleanupTombstone || event.stage !== 'after-cleanup-tombstone' || event.source !== sourceRoot) return;
      cleanupTombstone = event.quarantine;
      displacedOwnedSource = `${event.quarantine}.displaced`;
      fs.renameSync(event.quarantine, displacedOwnedSource);
      fs.mkdirSync(event.quarantine);
      fs.writeFileSync(path.join(event.quarantine, 'replacement.json'), '{"concurrent":true}\n');
    });

    try {
      const stateDir = getStateDir(workspace);
      const stateRoot = getWorkspaceStateRoot(workspace);
      assert.ok(cleanupTombstone);
      assert.ok(displacedOwnedSource);
      assert.equal(
        fs.readFileSync(path.join(cleanupTombstone, 'replacement.json'), 'utf8'),
        '{"concurrent":true}\n',
      );
      assert.equal(
        fs.readFileSync(path.join(displacedOwnedSource, 'tasks.json'), 'utf8'),
        '{"owned":"legacy"}\n',
      );
      assert.equal(fs.readFileSync(path.join(stateDir, 'tasks.json'), 'utf8'), '{"owned":"legacy"}\n');
      assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), false);
    } finally {
      _setLegacyWorkspaceMigrationHookForTests(undefined);
    }
  });
});

test('cliState: migration preserves symlinked legacy roots without following their targets', { skip: process.platform === 'win32' }, async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateRoot = getWorkspaceStateRoot(workspace);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-external-legacy-root-'));
    try {
      const sentinel = path.join(external, 'sentinel.json');
      fs.writeFileSync(sentinel, '{"keep":true}\n');
      const legacyRoot = path.join(workspace, '.brainrouter');
      fs.mkdirSync(legacyRoot, { recursive: true });
      const legacyCli = path.join(legacyRoot, 'cli');
      fs.symlinkSync(external, legacyCli);

      _resetLegacyWorkspaceMigrationForTests(workspace);
      const stateDir = getStateDir(workspace);

      assert.equal(fs.lstatSync(legacyCli).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"keep":true}\n');
      assert.equal(fs.existsSync(path.join(stateDir, 'sentinel.json')), false);
      assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), false);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});

test('cliState: migration preserves a legacy tree containing nested symlinks', { skip: process.platform === 'win32' }, async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateRoot = getWorkspaceStateRoot(workspace);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-external-legacy-child-'));
    try {
      const sentinel = path.join(external, 'sentinel.json');
      fs.writeFileSync(sentinel, '{"keep":true}\n');
      const legacyCli = path.join(workspace, '.brainrouter', 'cli');
      fs.mkdirSync(legacyCli, { recursive: true });
      fs.writeFileSync(path.join(legacyCli, 'safe.json'), '{"copy":true}\n');
      fs.symlinkSync(external, path.join(legacyCli, 'linked'));

      _resetLegacyWorkspaceMigrationForTests(workspace);
      const stateDir = getStateDir(workspace);

      assert.equal(fs.existsSync(legacyCli), true, 'an unsupported child keeps the source root in place');
      assert.equal(fs.readFileSync(path.join(stateDir, 'safe.json'), 'utf8'), '{"copy":true}\n');
      assert.equal(fs.existsSync(path.join(stateDir, 'linked')), false);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"keep":true}\n');
      assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), false);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});

test('cliState: migration never writes through a symlinked rescue destination', { skip: process.platform === 'win32' }, async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateRoot = getWorkspaceStateRoot(workspace);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-external-rescue-destination-'));
    try {
      fs.symlinkSync(external, path.join(stateRoot, 'cli'));
      const source = path.join(workspace, '.brainrouter', 'cli', 'tasks.json');
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, '{"legacy":true}\n');

      _resetLegacyWorkspaceMigrationForTests(workspace);
      getWorkspaceStateRoot(workspace);

      assert.equal(fs.readFileSync(source, 'utf8'), '{"legacy":true}\n');
      assert.equal(fs.existsSync(path.join(external, 'tasks.json')), false);
      assert.equal(fs.lstatSync(path.join(stateRoot, 'cli')).isSymbolicLink(), true);
      assert.equal(fs.existsSync(path.join(stateRoot, '.migrated-from-workspace')), false);
    } finally {
      fs.rmSync(path.join(stateRoot, 'cli'), { force: true });
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});

test('cliState: migration never follows a symlinked completion marker', { skip: process.platform === 'win32' }, async () => {
  const {
    _resetLegacyWorkspaceMigrationForTests,
    getStateDir,
    getWorkspaceStateRoot,
  } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const stateRoot = getWorkspaceStateRoot(workspace);
    const external = path.join(stateRoot, 'external-marker');
    fs.writeFileSync(external, 'do-not-overwrite\n');
    fs.symlinkSync(external, path.join(stateRoot, '.migrated-from-workspace'));
    const source = path.join(fs.realpathSync(workspace), '.brainrouter', 'cli', 'tasks.json');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, '{"legacy":true}\n');

    _resetLegacyWorkspaceMigrationForTests(workspace);
    getStateDir(workspace);

    assert.equal(fs.readFileSync(external, 'utf8'), 'do-not-overwrite\n');
    assert.equal(fs.readFileSync(source, 'utf8'), '{"legacy":true}\n');
    assert.equal(fs.lstatSync(path.join(stateRoot, '.migrated-from-workspace')).isSymbolicLink(), true);
  });
});

test('cliState: migration preserves an unverified <workspace>/.brainrouter.migrated archive', async () => {
  const { getStateDir } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    const staleArchive = path.join(workspace, '.brainrouter.migrated');
    fs.mkdirSync(path.join(staleArchive, 'cli'), { recursive: true });
    const archivedBytes = '{"unverified":"must survive"}\n';
    fs.writeFileSync(path.join(staleArchive, 'cli', 'tasks.json'), archivedBytes);
    fs.writeFileSync(path.join(staleArchive, 'future-project-artifact'), 'keep\n');
    // A legacy tree must exist for the migration body to run at all.
    const legacy = path.join(workspace, '.brainrouter');
    fs.mkdirSync(path.join(legacy, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'cli', 'tasks.json'), JSON.stringify({ items: [] }));

    getStateDir(workspace);

    assert.equal(fs.readFileSync(path.join(staleArchive, 'cli', 'tasks.json'), 'utf8'), archivedBytes);
    assert.equal(fs.readFileSync(path.join(staleArchive, 'future-project-artifact'), 'utf8'), 'keep\n');
  });
});

test('cliState: BRAINROUTER_HOME pins the user-global state root', async () => {
  const { getBrainrouterHome, getWorkspaceStateRoot } = await import('../storage/store.js');
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

test('cliState: migration skips a BRAINROUTER_HOME nested inside legacy personal state', () => {
  withTempWorkspace((workspace) => {
    const legacyCli = path.join(workspace, '.brainrouter', 'cli');
    fs.mkdirSync(legacyCli, { recursive: true });
    const sentinel = path.join(legacyCli, 'keep.json');
    fs.writeFileSync(sentinel, '{"keep":true}\n');
    process.env.BRAINROUTER_HOME = legacyCli;

    const stateDir = getStateDir(workspace);

    assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"keep":true}\n');
    assert.equal(stateDir.startsWith(path.join(fs.realpathSync(legacyCli), 'workspaces')), true);
    assert.equal(fs.existsSync(path.join(path.dirname(stateDir), '.migrated-from-workspace')), false);
  });
});

test('cliState: legacy <workspace>/.brainrouter/ migrates to the user home on first use', async () => {
  const { getStateDir } = await import('../storage/store.js');
  withTempWorkspace((workspace) => {
    // Plant legacy files inside the workspace as if they came from an older build.
    const legacyDir = path.join(workspace, '.brainrouter', 'cli');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'tasks.json'), JSON.stringify({ items: [{ step: 'legacy', status: 'pending' }] }));
    fs.writeFileSync(path.join(legacyDir, 'goal.json'), JSON.stringify({ text: 'old goal', setAt: '2026-01-01T00:00:00Z' }));

    const newDir = getStateDir(workspace);
    // Migrated files now exist in the user-home location.
    assert.equal(fs.existsSync(path.join(newDir, 'tasks.json')), true);
    assert.equal(fs.existsSync(path.join(newDir, 'goal.json')), true);
    // Migration marker is dropped.
    assert.equal(fs.existsSync(path.join(path.dirname(newDir), '.migrated-from-workspace')), true);
    // Second call is a no-op (idempotent — files already present, marker stays).
    getStateDir(workspace);
  });
});

test('cliState: listSessionDirs surfaces every session bucket newest first', async () => {
  const { listSessionDirs } = await import('../storage/store.js');
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
