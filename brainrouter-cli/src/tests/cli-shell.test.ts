import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTheme, resolveTheme } from '../cli/theme.js';
import { renderBanner } from '../cli/banner.js';
import { isKnownSegment, renderSegment, renderSegments, SEGMENT_NAMES } from '../cli/statusline.js';
import { gatherWhereInputs, renderWhere } from '../cli/whereView.js';
import { readPreferences, writePreferences } from '../state/preferencesStore.js';
import { blockGoal, setGoal, tickGoalIteration } from '../state/goalStore.js';
import { updatePlan } from '../state/taskStore.js';
import { createWorkflow } from '../state/workflowArtifacts.js';

/**
 * Tests for the 0.3.6 CLI shell redesign — theme, banner, statusline,
 * /where, quiet preference. Lives in its own file so the agent test
 * surface stays focused on the agent loop.
 */

function withTempWorkspace(fn: (workspace: string) => void) {
  const previousCwd = process.cwd();
  const previousWorkspace = process.env.BRAINROUTER_WORKSPACE;
  const previousHome = process.env.BRAINROUTER_HOME;
  const previousTheme = process.env.BRAINROUTER_THEME;
  const previousQuiet = process.env.BRAINROUTER_QUIET;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-cli-shell-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-home-shell-'));
  try {
    delete process.env.BRAINROUTER_WORKSPACE;
    delete process.env.BRAINROUTER_THEME;
    delete process.env.BRAINROUTER_QUIET;
    process.env.BRAINROUTER_HOME = home;
    process.chdir(workspace);
    fn(workspace);
  } finally {
    process.chdir(previousCwd);
    if (previousWorkspace === undefined) delete process.env.BRAINROUTER_WORKSPACE;
    else process.env.BRAINROUTER_WORKSPACE = previousWorkspace;
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    if (previousTheme === undefined) delete process.env.BRAINROUTER_THEME;
    else process.env.BRAINROUTER_THEME = previousTheme;
    if (previousQuiet === undefined) delete process.env.BRAINROUTER_QUIET;
    else process.env.BRAINROUTER_QUIET = previousQuiet;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---- theme ---------------------------------------------------------------

test('theme: mono palette returns identity (no ANSI escapes) for color tokens', () => {
  const theme = buildTheme('mono');
  // mono should leave plain strings unchanged on all semantic tokens
  // EXCEPT heading which keeps bold for legibility — that's the documented
  // tradeoff in theme.ts.
  for (const token of ['primary', 'secondary', 'success', 'warning', 'danger', 'info', 'muted', 'dim', 'plain'] as const) {
    const styled = theme[token]('hello');
    assert.equal(styled, 'hello', `mono.${token} should be identity`);
  }
  // heading is bold even in mono; just assert it contains the original text
  assert.ok(theme.heading('hello').includes('hello'));
});

test('theme: dark palette wraps text and reports mode = dark', () => {
  const theme = buildTheme('dark');
  // Whether chalk actually emits ANSI escapes depends on the test runner's
  // TTY detection. The invariant we DO control: the returned string always
  // contains the original text, and the palette identifies itself.
  const styled = theme.primary('hello');
  assert.equal(typeof styled, 'string');
  assert.ok(styled.includes('hello'));
  assert.equal(theme.mode, 'dark');
});

test('theme: BRAINROUTER_THEME env var wins over preference', () => {
  withTempWorkspace((workspace) => {
    writePreferences(workspace, { theme: 'light' });
    process.env.BRAINROUTER_THEME = 'mono';
    const resolved = resolveTheme(workspace);
    assert.equal(resolved.mode, 'mono');
  });
});

test('theme: preference is honored when env unset', () => {
  withTempWorkspace((workspace) => {
    writePreferences(workspace, { theme: 'light' });
    const resolved = resolveTheme(workspace);
    assert.equal(resolved.mode, 'light');
  });
});

test('theme: defaults to dark when nothing configured', () => {
  withTempWorkspace((workspace) => {
    const resolved = resolveTheme(workspace);
    assert.equal(resolved.mode, 'dark');
  });
});

test('theme: invalid env value falls through to default', () => {
  withTempWorkspace((workspace) => {
    process.env.BRAINROUTER_THEME = 'rainbow';
    const resolved = resolveTheme(workspace);
    assert.equal(resolved.mode, 'dark');
  });
});

// ---- banner --------------------------------------------------------------

test('banner: includes workspace, mcp, session, model rows', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    const banner = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'local-http',
      mcpTransport: 'http',
      mcpOnline: true,
      sessionKey: '7f3a1e0c-aaaa-bbbb-cccc-dddddddddddd',
      model: 'gpt-4o-mini',
    }, theme);
    assert.match(banner, /BrainRouter CLI/);
    assert.match(banner, /workspace/);
    assert.match(banner, /local-http/);
    assert.match(banner, /http/);
    assert.match(banner, /online/);
    assert.match(banner, /7f3a1e0c/);
    assert.match(banner, /gpt-4o-mini/);
  });
});

test('banner: offline mode reflected in mcp row', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    const banner = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'local',
      mcpTransport: 'stdio',
      mcpOnline: false,
      sessionKey: 'abc',
      model: 'gpt-4o-mini',
    }, theme);
    assert.match(banner, /offline/);
  });
});

test('banner: falls back to plain-text format on terminals under 38 cols', () => {
  // Simulate a narrow phone-style terminal so the boxed render-path's
  // borders would wrap and look broken. The fallback drops the box.
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', { value: 30, configurable: true });
    withTempWorkspace((workspace) => {
      const theme = buildTheme('mono');
      const banner = renderBanner({
        workspaceRoot: workspace,
        mcpProfile: 'local-http',
        mcpTransport: 'http',
        mcpOnline: true,
        sessionKey: 'abc12345',
        model: 'gpt-4o-mini',
      }, theme);
      // Plain-text format has no box-drawing characters.
      assert.doesNotMatch(banner, /[╭╮╰╯│]/);
      // But the row data is still present.
      assert.match(banner, /BrainRouter CLI/);
      assert.match(banner, /workspace/);
      assert.match(banner, /local-http/);
      assert.match(banner, /gpt-4o-mini/);
    });
  } finally {
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true });
  }
});

test('banner: brain row renders for BrainRouter MCP with online/offline state (10c)', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    const online = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'brainrouter-cloud',
      mcpTransport: 'http',
      mcpOnline: true,
      mcpIdentity: 'brainrouter',
      sessionKey: 'abc',
      model: 'm',
    }, theme);
    assert.match(online, /brain/, 'brain row label present when identity=brainrouter');
    assert.match(online, /online/);

    const offline = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'brainrouter-cloud',
      mcpTransport: 'http',
      mcpOnline: false,
      mcpIdentity: 'brainrouter',
      sessionKey: 'abc',
      model: 'm',
    }, theme);
    assert.match(offline, /brain/, 'brain row label present even when offline');
    assert.match(offline, /cloud unreachable/);
  });
});

test('banner: brain row omitted when identity is third-party (10c)', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    const banner = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'github',
      mcpTransport: 'http',
      mcpOnline: true,
      mcpIdentity: 'third-party',
      sessionKey: 'abc',
      model: 'm',
    }, theme);
    // Only the generic `mcp` row should mention online/offline state; the
    // distinct brain row is reserved for BrainRouter (or unknown / pending
    // detection). Third-party MCPs use the existing mcp row.
    const lines = banner.split('\n');
    const brainRows = lines.filter((l) => /\bbrain\b/.test(l));
    assert.equal(brainRows.length, 0, 'brain row must NOT appear for third-party MCPs');
  });
});

test('banner: brain row omitted when identity is unknown (10c)', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    const banner = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'local',
      mcpTransport: 'stdio',
      mcpOnline: true,
      mcpIdentity: 'unknown',
      sessionKey: 'abc',
      model: 'm',
    }, theme);
    const lines = banner.split('\n');
    const brainRows = lines.filter((l) => /\bbrain\b/.test(l));
    assert.equal(brainRows.length, 0, 'unknown identity = wait for tool-signature detection, no brain row yet');
  });
});

test('banner: workflow row appears when workflow is bound', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    const banner = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'p',
      mcpTransport: 'http',
      mcpOnline: true,
      sessionKey: 'abc',
      model: 'm',
      workflow: { slug: 'cli-shell-redesign', status: 'in-progress' },
    }, theme);
    assert.match(banner, /workflow/);
    assert.match(banner, /cli-shell-redesign/);
  });
});

test('banner: "last on" hint appears when session unbound but workspace has a last-used workflow', () => {
  // Post-decoupling, fresh CLI sessions don't auto-bind to whatever
  // workflow the previous CLI was on. The banner surfaces the workspace-
  // level "last used" hint as a one-line nudge instead — user can
  // `/workflow switch <slug>` to resume continuity, or just ignore it.
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    const banner = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'p',
      mcpTransport: 'http',
      mcpOnline: true,
      sessionKey: 'fresh',
      model: 'm',
      // Note: workflow is NOT set (unbound), lastUsedWorkflow IS set.
      lastUsedWorkflow: 'auth-refactor',
    }, theme);
    assert.match(banner, /last on/);
    assert.match(banner, /auth-refactor/);
    // The full "/workflow switch <slug>" hint may be clipped at the box
    // width on narrow terminals — just assert the lead-in is there.
    assert.match(banner, /\/workflow switch/);
  });
});

test('banner: "last on" hint NOT shown when current workflow IS bound', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    const banner = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'p',
      mcpTransport: 'http',
      mcpOnline: true,
      sessionKey: 'bound',
      model: 'm',
      workflow: { slug: 'cli-shell-redesign', status: 'bound' },
      // Both set — workflow wins, hint is suppressed.
      lastUsedWorkflow: 'some-other-workflow',
    }, theme);
    assert.match(banner, /cli-shell-redesign/);
    assert.doesNotMatch(banner, /last on/);
    assert.doesNotMatch(banner, /some-other-workflow/);
  });
});

test('banner: goal row appears when goal active and omits when absent', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    const goal = setGoal(workspace, 'finish the redesign', 'session-key', { maxIterations: 5 });
    const withGoal = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'p',
      mcpTransport: 'http',
      mcpOnline: true,
      sessionKey: 'abc',
      model: 'm',
      goal,
    }, theme);
    assert.match(withGoal, /goal/);
    assert.match(withGoal, /active/);
    assert.match(withGoal, /0 of 5 iterations/);

    const withoutGoal = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'p',
      mcpTransport: 'http',
      mcpOnline: true,
      sessionKey: 'abc',
      model: 'm',
    }, theme);
    assert.doesNotMatch(withoutGoal, /goal\s+active/);
  });
});

test('banner: unlimited budget renders as "unlimited"', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    const goal = setGoal(workspace, 'unlimited test', 'sk');
    const banner = renderBanner({
      workspaceRoot: workspace,
      mcpProfile: 'p',
      mcpTransport: 'http',
      mcpOnline: true,
      sessionKey: 'abc',
      model: 'm',
      goal,
    }, theme);
    assert.match(banner, /unlimited/);
  });
});

// ---- statusline -----------------------------------------------------------

test('statusline: SEGMENT_NAMES includes the new workflow/goal/plan/pr segments', () => {
  for (const name of ['mode', 'model', 'tokens', 'session', 'branch', 'dirty', 'pr', 'workflow', 'goal', 'plan']) {
    assert.ok(SEGMENT_NAMES.includes(name as any), `expected '${name}' in SEGMENT_NAMES`);
  }
});

test('statusline: isKnownSegment recognizes valid + rejects invalid', () => {
  assert.equal(isKnownSegment('mode'), true);
  assert.equal(isKnownSegment('plan'), true);
  assert.equal(isKnownSegment('rainbows'), false);
});

test('statusline: mode + model + session segments render synchronously', () => {
  const seg = renderSegment('mode', {
    workspaceRoot: '/tmp',
    sessionKey: 'abcdef',
    accessMode: 'shell',
    model: 'gpt-5',
    lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
  });
  assert.equal(seg, 'shell');
  assert.equal(renderSegment('model', {
    workspaceRoot: '/tmp', sessionKey: 'a', accessMode: 'read', model: 'gpt-5',
    lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
  }), 'gpt-5');
  assert.equal(renderSegment('session', {
    workspaceRoot: '/tmp', sessionKey: 'short-key', accessMode: 'read', model: 'm',
    lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
  }), 'short-key');
});

test('statusline: tokens segment returns undefined before the first turn', () => {
  const seg = renderSegment('tokens', {
    workspaceRoot: '/tmp',
    sessionKey: 'a',
    accessMode: 'read',
    model: 'm',
    lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
  });
  assert.equal(seg, undefined);
});

test('statusline: tokens segment surfaces last-turn counts when calls > 0', () => {
  const seg = renderSegment('tokens', {
    workspaceRoot: '/tmp',
    sessionKey: 'a',
    accessMode: 'read',
    model: 'm',
    lastTurnUsage: { calls: 2, promptTokens: 1234, completionTokens: 567 },
  });
  assert.equal(seg, '1234↑567↓');
});

test('statusline: workflow segment returns wf:<slug> when bound', () => {
  withTempWorkspace((workspace) => {
    // 9d-bugfix: pass sessionKey through createWorkflow so the binding
    // is per-session; otherwise getCurrentWorkflow(ws, sessionKey)
    // returns undefined for this fresh test session and the segment
    // renders as undefined.
    createWorkflow(workspace, { title: 'My Feature', kind: 'feature-dev', sessionKey: 'sk' });
    const seg = renderSegment('workflow', {
      workspaceRoot: workspace,
      sessionKey: 'sk',
      accessMode: 'read',
      model: 'm',
      lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    });
    assert.match(String(seg), /^wf:my-feature$/);
  });
});

test('statusline: workflow segment undefined when no workflow bound', () => {
  withTempWorkspace((workspace) => {
    const seg = renderSegment('workflow', {
      workspaceRoot: workspace, sessionKey: 'sk', accessMode: 'read', model: 'm',
      lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    });
    assert.equal(seg, undefined);
  });
});

test('statusline: workflow segment is pure navigation (no goal-status annotation, post-decoupling)', async () => {
  // Pre-decoupling (Item 3) the workflow segment picked up paused /
  // blocked / usage_limited as a parenthesized tag because workflows
  // carried their own goals. Post-decoupling the workflow segment is
  // purely "which folder is this session writing artifacts to" — goal
  // status lives entirely in the separate `goal` segment.
  const { pauseGoal, blockGoal, usageLimitGoal } = await import('../state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:wf-segment';
    createWorkflow(workspace, { title: 'flagged feature', kind: 'feature-dev', sessionKey: sk });
    const renderWf = () => renderSegment('workflow', {
      workspaceRoot: workspace, sessionKey: sk, accessMode: 'read', model: 'm',
      lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    });

    // Pre-goal: bare slug.
    assert.equal(renderWf(), 'wf:flagged-feature');

    // Active goal: still bare.
    setGoal(workspace, 'do the thing', sk);
    assert.equal(renderWf(), 'wf:flagged-feature');

    // Paused: STILL bare (workflow segment is navigation-only).
    pauseGoal(workspace, sk);
    assert.equal(renderWf(), 'wf:flagged-feature', 'workflow segment must NOT annotate goal halt-state post-decoupling');

    // Blocked: same.
    blockGoal(workspace, sk, 'waiting on prod creds');
    assert.equal(renderWf(), 'wf:flagged-feature');

    // usage_limited: same.
    usageLimitGoal(workspace, sk, 'iteration cap reached');
    assert.equal(renderWf(), 'wf:flagged-feature');
  });
});

test('statusline: goal segment renders status + used/cap for an active goal', () => {
  withTempWorkspace((workspace) => {
    setGoal(workspace, 'test the segments', 'session-x', { maxIterations: 4 });
    tickGoalIteration(workspace, 'session-x');
    const seg = renderSegment('goal', {
      workspaceRoot: workspace,
      sessionKey: 'session-x',
      accessMode: 'read',
      model: 'm',
      lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    });
    assert.equal(seg, 'goal:active 1/4');
  });
});

test('statusline: plan segment renders done/total when a plan exists', () => {
  withTempWorkspace((workspace) => {
    updatePlan(workspace, {
      plan: [
        { step: 'one', status: 'completed' },
        { step: 'two', status: 'completed' },
        { step: 'three', status: 'in_progress' },
        { step: 'four', status: 'pending' },
      ],
    }, 'session-plan');
    const seg = renderSegment('plan', {
      workspaceRoot: workspace,
      sessionKey: 'session-plan',
      accessMode: 'read',
      model: 'm',
      lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    });
    assert.equal(seg, 'plan:2/4');
  });
});

test('statusline: renderSegments drops empty results and preserves order', () => {
  withTempWorkspace((workspace) => {
    const out = renderSegments(['mode', 'tokens', 'workflow', 'session'], {
      workspaceRoot: workspace,
      sessionKey: 'short',
      accessMode: 'write',
      model: 'm',
      lastTurnUsage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    });
    // tokens (no turn yet) + workflow (none bound) drop out.
    assert.deepEqual(out, ['write', 'short']);
  });
});

// ---- /where ---------------------------------------------------------------

test('/where: empty workspace renders only the workspace section', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    const inputs = gatherWhereInputs({
      workspaceRoot: workspace,
      sessionKey: 'session-key-xyz',
      model: 'gpt-4o-mini',
      mcpProfile: 'local-http',
      mcpTransport: 'http',
      mcpOnline: true,
      accessMode: 'shell',
      recalledRecords: [],
      briefingSources: [],
    });
    const out = renderWhere(inputs, theme);
    assert.match(out, /Workspace/);
    assert.doesNotMatch(out, /Workflow/);
    assert.doesNotMatch(out, /Goal/);
    assert.doesNotMatch(out, /Plan/);
    assert.doesNotMatch(out, /Recent recall/);
    assert.doesNotMatch(out, /Active children/);
  });
});

test('/where: shows workflow, goal, and plan sections when populated', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    createWorkflow(workspace, { title: 'CLI Shell Redesign', kind: 'feature-dev', sessionKey: 'sk-where' });
    setGoal(workspace, 'land the CLI shell redesign cleanly', 'sk-where', { maxIterations: 8 });
    updatePlan(workspace, {
      explanation: 'shape the work into bite-sized commits',
      plan: [
        { step: 'theme module', status: 'completed' },
        { step: 'banner', status: 'completed' },
        { step: 'statusline segments', status: 'in_progress' },
        { step: 'where view', status: 'pending' },
      ],
    }, 'sk-where');
    const inputs = gatherWhereInputs({
      workspaceRoot: workspace,
      sessionKey: 'sk-where',
      model: 'gpt-4o-mini',
      mcpProfile: 'local-http',
      mcpTransport: 'http',
      mcpOnline: true,
      accessMode: 'shell',
      recalledRecords: [
        { recordId: 'rec_a', type: 'codebase_fact', content: 'cliPrompt.ts has askYesNo', priority: 0.91 },
        { recordId: 'rec_b', type: 'instruction', content: 'Use chalk theme module', priority: 0.62 },
      ],
      briefingSources: ['memory_recall', 'list_skills'],
    });
    const out = renderWhere(inputs, theme);
    assert.match(out, /Workspace/);
    assert.match(out, /Workflow/);
    assert.match(out, /cli-shell-redesign/);
    assert.match(out, /Goal/);
    assert.match(out, /ACTIVE/);
    assert.match(out, /land the CLI shell redesign cleanly/);
    assert.match(out, /Plan/);
    assert.match(out, /shape the work/);
    assert.match(out, /✓ theme module/);
    assert.match(out, /⏳ statusline segments/);
    assert.match(out, /☐ where view/);
    assert.match(out, /Recent recall/);
    assert.match(out, /memory_recall, list_skills/);
    assert.match(out, /askYesNo/);
  });
});

test('/where: blocked goal surfaces blockedReason', () => {
  withTempWorkspace((workspace) => {
    const theme = buildTheme('mono');
    setGoal(workspace, 'something hard', 'sk-blocked', { maxIterations: 3 });
    blockGoal(workspace, 'sk-blocked', 'missing api key from user');
    const inputs = gatherWhereInputs({
      workspaceRoot: workspace,
      sessionKey: 'sk-blocked',
      model: 'm',
      mcpProfile: 'p',
      mcpTransport: 'http',
      mcpOnline: true,
      accessMode: 'read',
      recalledRecords: [],
      briefingSources: [],
    });
    const out = renderWhere(inputs, theme);
    assert.match(out, /BLOCKED/);
    assert.match(out, /missing api key/);
  });
});

// ---- preferences (quiet) -------------------------------------------------

test('preferencesStore: quiet defaults to false', () => {
  withTempWorkspace((workspace) => {
    const prefs = readPreferences(workspace);
    assert.equal(prefs.quiet, false);
  });
});

test('preferencesStore: writePreferences round-trips quiet', () => {
  withTempWorkspace((workspace) => {
    writePreferences(workspace, { quiet: true });
    const prefs = readPreferences(workspace);
    assert.equal(prefs.quiet, true);
    // other fields unaffected
    assert.equal(prefs.statusline, 'mode');
    assert.equal(prefs.theme, 'auto');
  });
});
