import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatToolCall,
  stripMcpPrefix,
  snakeToPascal,
  quoteShort,
  truncateOneLine,
  classifyDiffLine,
  looksLikeDiff,
} from '../cli/ink/toolFormat.js';

// --- stripMcpPrefix ---------------------------------------------------

test('stripMcpPrefix: strips canonical single-underscore mcp_<server>_ prefix', () => {
  assert.equal(stripMcpPrefix('mcp_brainrouter_memory_search'), 'memory_search');
  assert.equal(stripMcpPrefix('mcp_github_create_issue'), 'create_issue');
});

test('stripMcpPrefix: leaves non-MCP names alone', () => {
  assert.equal(stripMcpPrefix('read_file'), 'read_file');
  assert.equal(stripMcpPrefix('spawn_agent'), 'spawn_agent');
});

// --- snakeToPascal ----------------------------------------------------

test('snakeToPascal: converts snake_case to PascalCase', () => {
  assert.equal(snakeToPascal('memory_search'), 'MemorySearch');
  assert.equal(snakeToPascal('create_pull_request'), 'CreatePullRequest');
});

test('snakeToPascal: single-word names get just an initial cap', () => {
  assert.equal(snakeToPascal('bash'), 'Bash');
});

test('snakeToPascal: ignores empty segments from double underscores', () => {
  assert.equal(snakeToPascal('foo__bar'), 'FooBar');
});

// --- quoteShort -------------------------------------------------------

test('quoteShort: wraps the value in double quotes and truncates', () => {
  assert.equal(quoteShort('hello', 20), '"hello"');
  assert.equal(quoteShort('a'.repeat(30), 10), '"aaaaaaaaa…"');
});

test('quoteShort: collapses internal whitespace to single spaces', () => {
  assert.equal(quoteShort('  hello   world\n\tnext  ', 50), '"hello world next"');
});

test('quoteShort: returns empty-quotes for missing / non-string input', () => {
  assert.equal(quoteShort(undefined, 20), '""');
  assert.equal(quoteShort(null, 20), '""');
  assert.equal(quoteShort('', 20), '""');
  assert.equal(quoteShort(42, 20), '""');
});

// --- truncateOneLine --------------------------------------------------

test('truncateOneLine: collapses whitespace and truncates at max chars', () => {
  assert.equal(truncateOneLine('hello world', 20), 'hello world');
  assert.equal(truncateOneLine('a\nb\nc', 20), 'a b c');
  assert.equal(truncateOneLine('a'.repeat(50), 10), 'aaaaaaaaa…');
});

test('truncateOneLine: empty / non-string input returns empty string', () => {
  assert.equal(truncateOneLine(undefined, 20), '');
  assert.equal(truncateOneLine(42, 20), '');
});

// --- formatToolCall: built-in tools -----------------------------------

test('formatToolCall: read_file renders Read(path) with optional line range', () => {
  assert.equal(formatToolCall('read_file', { path: 'src/foo.ts' }), 'Read(src/foo.ts)');
  assert.equal(formatToolCall('read_file', { path: 'a.ts', startLine: 10 }), 'Read(a.ts:10)');
  assert.equal(formatToolCall('read_file', { path: 'a.ts', startLine: 10, endLine: 25 }), 'Read(a.ts:10-25)');
});

test('formatToolCall: write_file / edit_file render the path', () => {
  assert.equal(formatToolCall('write_file', { path: 'src/foo.ts', content: '...' }), 'Write(src/foo.ts)');
  assert.equal(formatToolCall('edit_file', { path: 'src/foo.ts', targetContent: 'X', replacementContent: 'Y' }), 'Edit(src/foo.ts)');
});

test('formatToolCall: list_dir renders LS(.) for empty / default', () => {
  assert.equal(formatToolCall('list_dir', {}), 'LS(.)');
  assert.equal(formatToolCall('list_dir', { path: 'src/' }), 'LS(src/)');
});

test('formatToolCall: grep_search wraps the query in quotes', () => {
  assert.equal(formatToolCall('grep_search', { query: 'authenticate' }), 'Grep("authenticate")');
  assert.equal(formatToolCall('grep_search', { query: 'foo bar', path: '.' }), 'Grep("foo bar")');
});

test('formatToolCall: glob_files / fetch_url / web_search', () => {
  assert.equal(formatToolCall('glob_files', { pattern: '**/*.ts' }), 'Glob("**/*.ts")');
  assert.equal(formatToolCall('fetch_url', { url: 'https://example.com/docs' }), 'Fetch(https://example.com/docs)');
  assert.equal(formatToolCall('web_search', { query: 'react hooks' }), 'WebSearch("react hooks")');
});

test('formatToolCall: run_command renders as Bash(cmd) with truncation', () => {
  assert.equal(formatToolCall('run_command', { command: 'npm test' }), 'Bash(npm test)');
  const long = 'a'.repeat(100);
  const result = formatToolCall('run_command', { command: long });
  assert.match(result, /^Bash\(.+…\)$/);
  assert.ok(result.length < 100);
});

test('formatToolCall: spawn_agent shows role + truncated prompt', () => {
  assert.equal(
    formatToolCall('spawn_agent', { role: 'researcher', prompt: 'find auth logic' }),
    'Spawn(researcher, "find auth logic")',
  );
  assert.equal(
    formatToolCall('spawn_agent', { role: 'worker', label: 'auth', prompt: 'short' }),
    'Spawn(worker [auth], "short")',
  );
});

test('formatToolCall: task_agent and delegate_agent show foreground/background intent', () => {
  assert.equal(
    formatToolCall('task_agent', { role: 'reviewer', prompt: 'review current diff' }),
    'Task(reviewer, "review current diff")',
  );
  assert.equal(
    formatToolCall('delegate_agent', { agentId: 'custom-researcher', label: 'docs', prompt: 'map CLI docs' }),
    'Delegate(custom-researcher [docs], "map CLI docs")',
  );
});

test('formatToolCall: spawn_agents summarizes count + roles', () => {
  assert.equal(
    formatToolCall('spawn_agents', { agents: [{ role: 'r1' }, { role: 'r2' }, { role: 'r3' }] }),
    'SpawnAll(3: r1, r2, r3)',
  );
  assert.equal(formatToolCall('spawn_agents', { agents: [] }), 'SpawnAll(0: )');
});

// --- formatToolCall: MCP + unknown tools ------------------------------

test('formatToolCall: MCP tools strip the mcp_<server>_ namespace prefix', () => {
  // Unknown / MCP tools take the generic fallback path: snake_case →
  // PascalCase + first-string-arg without quoting (matches Bash/Fetch
  // behavior — quoting is reserved for explicit query-shaped tools like
  // Grep / WebSearch).
  assert.equal(
    formatToolCall('mcp_brainrouter_memory_search', { query: 'auth' }),
    'MemorySearch(auth)',
  );
});

test('formatToolCall: unknown tools fall back to PascalCase(firstStringArg)', () => {
  assert.equal(
    formatToolCall('something_unknown', { important: 'value', other: 42 }),
    'SomethingUnknown(value)',
  );
});

test('formatToolCall: unknown tools with no string args render as Name()', () => {
  assert.equal(formatToolCall('compute', { x: 1, y: 2 }), 'Compute()');
  assert.equal(formatToolCall('compute', {}), 'Compute()');
});

test('formatToolCall: missing args object is tolerated', () => {
  assert.equal(formatToolCall('read_file', undefined), 'Read(.)');
});

// --- diff detection ---------------------------------------------------

test('classifyDiffLine: detects file headers / hunks / +/-', () => {
  assert.equal(classifyDiffLine('+++ b/src/foo.ts'), 'header');
  assert.equal(classifyDiffLine('--- a/src/foo.ts'), 'header');
  assert.equal(classifyDiffLine('@@ -10,3 +10,4 @@'), 'hunk');
  assert.equal(classifyDiffLine('+ added line'), 'add');
  assert.equal(classifyDiffLine('- removed line'), 'del');
});

test('classifyDiffLine: returns undefined for non-diff lines', () => {
  assert.equal(classifyDiffLine('normal text'), undefined);
  assert.equal(classifyDiffLine(''), undefined);
  assert.equal(classifyDiffLine('  indented text'), undefined);
});

test('looksLikeDiff: true for a unified diff snippet', () => {
  const diff = `--- a/file
+++ b/file
@@ -1,3 +1,3 @@
 unchanged
-removed
+added`;
  assert.equal(looksLikeDiff(diff), true);
});

test('looksLikeDiff: true when there are 2+ +/- gutter lines without an @@', () => {
  assert.equal(looksLikeDiff('+line one\n+line two'), true);
});

test('looksLikeDiff: false for plain prose', () => {
  assert.equal(looksLikeDiff('hello\nworld\nfoo bar'), false);
  assert.equal(looksLikeDiff(''), false);
});
