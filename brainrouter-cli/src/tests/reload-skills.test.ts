import test from 'node:test';
import assert from 'node:assert/strict';
import { SLASH_COMMANDS, HELP_CATEGORIES } from '../cli/prompt/repl.js';
import { listFilesystemSkills, skillSearchRoots } from '../prompt/skillCatalog.js';

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

test('CC-CONFIG-A6 skillSearchRoots: includeBundled:false keeps only workspace roots', () => {
  const ws = '/tmp/some/workspace';
  const all = skillSearchRoots(ws, { includeBundled: true });
  const workspaceOnly = skillSearchRoots(ws, { includeBundled: false });
  // Every workspace-only root is under the workspace path (no install/monorepo roots).
  assert.ok(workspaceOnly.every((r) => r.startsWith('/tmp/some/workspace')), 'only workspace-scoped roots remain');
  assert.ok(workspaceOnly.length <= all.length, 'hiding bundled never adds roots');
});

test('CC-CONFIG-A1 listFilesystemSkills: safe mode returns no skills', async () => {
  const { setCliKnobOverride, _resetCliKnobsCache } = await import('@kinqs/brainrouter-core/config');
  try {
    _resetCliKnobsCache(); // clear cache/overrides FIRST, then set the override (reset wipes overrides)
    setCliKnobOverride({ safeMode: true });
    // Point at the monorepo root so bundled skills WOULD be found if not for safe mode.
    const skills = listFilesystemSkills(process.cwd());
    assert.deepEqual(skills, [], 'safe mode loads zero skills');
  } finally {
    _resetCliKnobsCache();
  }
});
