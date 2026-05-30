import test from 'node:test';
import assert from 'node:assert/strict';
import { SLASH_COMMANDS, HELP_CATEGORIES } from '../cli/repl.js';
import { skillSearchRoots } from '../prompt/skillCatalog.js';

/**
 * CLI-17 (0.4.4) — `/reload-skills` forces a re-scan of the skill directories.
 * The handler is integration-heavy (mcp + agent); here we assert it's wired
 * (registered + documented) and that its core dependency reports the dirs the
 * re-scan will cover.
 */

test('CLI-17 /reload-skills is a registered, documented command', () => {
  assert.ok(SLASH_COMMANDS.includes('/reload-skills'), 'registered in SLASH_COMMANDS');
  const documented = HELP_CATEGORIES.some((c) => c.entries.some((e) => e.cmd.startsWith('/reload-skills')));
  assert.ok(documented, 'has a /help row');
});

test('CLI-17 skillSearchRoots reports the directories the re-scan covers', () => {
  const roots = skillSearchRoots('/tmp/some/workspace');
  assert.ok(Array.isArray(roots) && roots.length >= 1, 'at least one skill search root');
  assert.ok(roots.every((r) => typeof r === 'string' && r.length > 0));
});
