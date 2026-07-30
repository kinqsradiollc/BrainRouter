/**
 * MC-B3 — automation rules: frontmatter parsing, the safe `when`
 * mini-expression evaluator (every operator + malformed → false), match
 * routing over neutral trigger events, and enable/disable persisting into
 * the source `.md` file. All offline, all against temp directories.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  automationsDir,
  buildAutomationEvent,
  evaluateWhen,
  listAutomationRules,
  loadRules,
  matchRules,
  parseAutomationRuleContent,
  readTriggerPayload,
  setAutomationRuleEnabled,
  WHEN_EXPRESSION_MAX_LENGTH,
  type AutomationRule,
  type TriggerEvent,
} from '../triggers/index.js';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-automations-'));
}

function writeRule(ws: string, id: string, content: string): string {
  const dir = automationsDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

const BUILD_RULE = `---
name: Build on label
on: 'github.issue.labeled'
when: "label == 'brainrouter'"
do: build
enabled: true
---

Focus on the failing suite first.
`;

function triggerEvent(over: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    provider: 'github',
    kind: 'issue.labeled',
    repo: 'acme/widgets',
    number: 41,
    sender: 'octocat',
    payloadRef: '',
    receivedAt: new Date().toISOString(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

test('parse: full rule file → every field, quotes stripped, body captured', () => {
  const rule = parseAutomationRuleContent(BUILD_RULE, 'build-on-label', '/x/build-on-label.md');
  assert.ok(rule);
  assert.equal(rule.id, 'build-on-label');
  assert.equal(rule.name, 'Build on label');
  assert.equal(rule.on, 'github.issue.labeled');
  assert.equal(rule.when, "label == 'brainrouter'");
  assert.equal(rule.do, 'build');
  assert.equal(rule.enabled, true);
  assert.equal(rule.instructions, 'Focus on the failing suite first.');
  assert.equal(rule.sourcePath, '/x/build-on-label.md');
});

test('parse: defaults — enabled defaults true, do defaults custom, name falls back to id', () => {
  const rule = parseAutomationRuleContent('---\non: github.ping\n---\nbody', 'r1', '/x/r1.md');
  assert.ok(rule);
  assert.equal(rule.enabled, true);
  assert.equal(rule.do, 'custom');
  assert.equal(rule.name, 'r1');
  assert.equal(rule.when, '');
});

test('parse: fail-closed — missing on, unknown do, or no frontmatter → null', () => {
  assert.equal(parseAutomationRuleContent('---\ndo: build\n---\n', 'r', '/x/r.md'), null);
  assert.equal(
    parseAutomationRuleContent('---\non: github.ping\ndo: deploy-to-prod\n---\n', 'r', '/x/r.md'),
    null,
    'an explicit unknown action is dropped, never guessed at',
  );
  assert.equal(parseAutomationRuleContent('just a markdown file', 'r', '/x/r.md'), null);
});

test('parse: enabled "false" string disables; comments and blank lines skipped', () => {
  const rule = parseAutomationRuleContent(
    '---\n# routing\non: github.ping\n\nenabled: false\n---\n',
    'r',
    '/x/r.md',
  );
  assert.ok(rule);
  assert.equal(rule.enabled, false);
});

// ---------------------------------------------------------------------------
// The `when` evaluator — every operator, then the malformed zoo.
// ---------------------------------------------------------------------------

test('when: == over plain strings and GitHub-style { name } objects', () => {
  assert.equal(evaluateWhen("label == 'brainrouter'", { label: 'brainrouter' }), true);
  assert.equal(evaluateWhen("label == 'brainrouter'", { label: { name: 'brainrouter' } }), true);
  assert.equal(evaluateWhen("label.name == 'brainrouter'", { label: { name: 'brainrouter' } }), true);
  assert.equal(evaluateWhen("label == 'brainrouter'", { label: 'other' }), false);
  assert.equal(evaluateWhen("label == 'brainrouter'", {}), false);
});

test('when: != (missing field is not equal to any non-empty literal)', () => {
  assert.equal(evaluateWhen("sender != 'bot'", { sender: 'octocat' }), true);
  assert.equal(evaluateWhen("sender != 'bot'", { sender: 'bot' }), false);
  assert.equal(evaluateWhen("sender != 'bot'", {}), true);
});

test('when: && and || compose; parentheses group', () => {
  const fields = { label: 'brainrouter', sender: 'octocat', repo: 'acme/widgets' };
  assert.equal(evaluateWhen("label == 'brainrouter' && sender == 'octocat'", fields), true);
  assert.equal(evaluateWhen("label == 'x' && sender == 'octocat'", fields), false);
  assert.equal(evaluateWhen("label == 'x' || sender == 'octocat'", fields), true);
  assert.equal(evaluateWhen("label == 'x' || sender == 'y'", fields), false);
  assert.equal(
    evaluateWhen("(label == 'x' || sender == 'octocat') && repo == 'acme/widgets'", fields),
    true,
  );
});

test('when: ! negates; bare fields are truthiness checks', () => {
  assert.equal(evaluateWhen("!(label == 'x')", { label: 'brainrouter' }), true);
  assert.equal(evaluateWhen('!draft', { draft: false }), true, 'boolean false is falsy');
  assert.equal(evaluateWhen('!draft', { draft: true }), false);
  assert.equal(evaluateWhen('!missing', {}), true);
  assert.equal(evaluateWhen('label', { label: 'brainrouter' }), true);
  assert.equal(evaluateWhen('label', { label: '' }), false);
});

test('when: dot paths walk nested payloads; numbers compare as strings', () => {
  const fields = { issue: { user: { login: 'octocat' } }, number: 41 };
  assert.equal(evaluateWhen("issue.user.login == 'octocat'", fields), true);
  assert.equal(evaluateWhen("number == '41'", fields), true);
  assert.equal(evaluateWhen("issue.user.login == 'bot'", fields), false);
  assert.equal(evaluateWhen("issue.missing.deep == 'x'", fields), false);
});

test('when: empty expression is unconditional true', () => {
  assert.equal(evaluateWhen('', { anything: 'x' }), true);
  assert.equal(evaluateWhen('   ', {}), true);
});

test('when: malformed input is ALWAYS safe false, never a throw', () => {
  const fields = { label: 'brainrouter' };
  const malformed = [
    "label ==",                        // missing operand
    "label == 'unterminated",          // unclosed string literal
    "(label == 'x'",                   // unbalanced paren
    "label = 'x'",                     // single = is not in the language
    "label === 'x'",                   // stray = after ==
    "label 'x'",                       // adjacent operands
    "label == 'x' &&",                 // dangling operator
    "== 'x'",                          // operator without left side
    "label && || sender",              // operator soup
    "process.exit(0)",                 // looks like code → just an unparseable call
    "a; b",                            // statement separators don't exist
    "label == `x`",                    // backticks are not string literals
    "𝕩 == 'x'",                        // non-ASCII identifier start
    `label == '${'x'.repeat(WHEN_EXPRESSION_MAX_LENGTH + 10)}'`, // over the cap
  ];
  for (const expr of malformed) {
    assert.equal(evaluateWhen(expr, fields), false, `expected safe false for: ${expr}`);
  }
});

test('when: escaped quotes inside literals survive', () => {
  assert.equal(evaluateWhen("title == 'it\\'s broken'", { title: "it's broken" }), true);
  assert.equal(evaluateWhen('title == "say \\"hi\\""', { title: 'say "hi"' }), true);
});

// ---------------------------------------------------------------------------
// Match routing
// ---------------------------------------------------------------------------

test('matchRules routes by on + when + enabled', () => {
  const ws = tempWorkspace();
  writeRule(ws, 'build-on-label', BUILD_RULE);
  writeRule(ws, 'review-on-open', '---\non: github.pull_request.opened\ndo: review\n---\n');
  writeRule(ws, 'disabled-rule', '---\non: github.issue.labeled\ndo: build\nenabled: false\n---\n');
  writeRule(ws, 'wrong-label', "---\non: github.issue.labeled\nwhen: \"label == 'other'\"\ndo: build\n---\n");
  writeRule(ws, 'not-a-rule', 'plain markdown, no frontmatter');

  const rules = loadRules(ws);
  assert.deepEqual(
    rules.map((r) => r.id),
    ['build-on-label', 'disabled-rule', 'review-on-open', 'wrong-label'],
    'sorted, malformed file skipped',
  );

  const labeled = buildAutomationEvent(triggerEvent(), { label: { name: 'brainrouter' } });
  assert.equal(labeled.on, 'github.issue.labeled');
  assert.deepEqual(matchRules(rules, labeled).map((r) => r.id), ['build-on-label']);

  const opened = buildAutomationEvent(
    triggerEvent({ kind: 'pull_request.opened', number: 7 }),
  );
  assert.deepEqual(matchRules(rules, opened).map((r) => r.id), ['review-on-open']);

  const unrelated = buildAutomationEvent(triggerEvent({ kind: 'ping' }));
  assert.deepEqual(matchRules(rules, unrelated), []);
});

test('buildAutomationEvent: envelope fields overlay payload keys and always win', () => {
  const event = buildAutomationEvent(
    triggerEvent(),
    { label: { name: 'brainrouter' }, sender: { login: 'spoofed' }, repo: 'spoofed/repo' },
  );
  assert.equal(event.fields.sender, 'octocat', 'verified envelope beats raw payload');
  assert.equal(event.fields.repo, 'acme/widgets');
  assert.equal(event.fields.number, 41);
  assert.deepEqual(event.fields.label, { name: 'brainrouter' });
});

test('readTriggerPayload: round-trips a payloadRef file; safe null otherwise', () => {
  const ws = tempWorkspace();
  const file = path.join(ws, 'payload.json');
  fs.writeFileSync(file, JSON.stringify({ label: { name: 'brainrouter' } }), 'utf8');
  assert.deepEqual(readTriggerPayload({ payloadRef: file }), { label: { name: 'brainrouter' } });
  assert.equal(readTriggerPayload({ payloadRef: '' }), null);
  assert.equal(readTriggerPayload({ payloadRef: path.join(ws, 'missing.json') }), null);
  fs.writeFileSync(file, 'not json', 'utf8');
  assert.equal(readTriggerPayload({ payloadRef: file }), null);
});

// ---------------------------------------------------------------------------
// Registry enable/disable persistence
// ---------------------------------------------------------------------------

test('setAutomationRuleEnabled flips the frontmatter line and persists across reloads', () => {
  const ws = tempWorkspace();
  writeRule(ws, 'build-on-label', BUILD_RULE);

  assert.equal(setAutomationRuleEnabled(ws, 'build-on-label', false), true);
  let rule = listAutomationRules(ws).find((r) => r.id === 'build-on-label') as AutomationRule;
  assert.equal(rule.enabled, false);
  assert.equal(rule.instructions, 'Focus on the failing suite first.', 'body untouched');
  assert.deepEqual(
    matchRules([rule], buildAutomationEvent(triggerEvent(), { label: { name: 'brainrouter' } })),
    [],
    'a disabled rule never fires',
  );

  assert.equal(setAutomationRuleEnabled(ws, 'build-on-label', true), true);
  rule = listAutomationRules(ws).find((r) => r.id === 'build-on-label') as AutomationRule;
  assert.equal(rule.enabled, true);
});

test('setAutomationRuleEnabled inserts the line when frontmatter never had one', () => {
  const ws = tempWorkspace();
  writeRule(ws, 'bare', '---\non: github.ping\n---\nbody');
  assert.equal(setAutomationRuleEnabled(ws, 'bare', false), true);
  const rule = listAutomationRules(ws).find((r) => r.id === 'bare');
  assert.equal(rule?.enabled, false);
});

test('setAutomationRuleEnabled: unknown or unsafe ids are rejected without touching disk', () => {
  const ws = tempWorkspace();
  writeRule(ws, 'real', '---\non: github.ping\n---\n');
  assert.equal(setAutomationRuleEnabled(ws, 'ghost', false), false);
  assert.equal(setAutomationRuleEnabled(ws, '../real', false), false);
  assert.equal(setAutomationRuleEnabled(ws, '.hidden', false), false);
  assert.equal(setAutomationRuleEnabled(ws, '', false), false);
});
