/**
 * CONFIG-HYDRATE (0.4.11) — config.json self-fills missing safe cli.* defaults
 * so every knob is visible + editable, WITHOUT shadowing the preference-layered
 * knobs (/theme · /effort · /quiet) or clobbering user overrides.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateCliDefaults } from '../config/config.js';

test('CONFIG-HYDRATE fills safe cli.* defaults + excludes preference-layered knobs', () => {
  const cfg: any = { activeServer: '', servers: {} };
  const { config, added } = hydrateCliDefaults(cfg);
  assert.ok(added > 20, `hydrates many knobs (got ${added})`);
  // Safe knobs present at their documented defaults.
  assert.equal(config.cli?.maxConcurrentChildren, 8);
  assert.equal(config.cli?.llmMaxConcurrent, 4);
  assert.equal(config.cli?.childWorkspaceIsolation, 'auto');
  assert.equal(config.cli?.buildLoop, 'escalate'); // BUILD-LOOP P3 — auto-hydrated safe default
  assert.equal(config.cli?.worktreeMergeReview, 'off'); // BUILD-LOOP P2.5 — auto-hydrated safe default
  assert.equal(config.cli?.buildLoopMaxRepairs, 0); // BUILD-LOOP P5 — default 0 = disabled
  // Preference-layered knobs left OUT so /theme · /effort · /quiet stay dynamic.
  const cli = config.cli as Record<string, unknown>;
  assert.equal('theme' in cli, false);
  assert.equal('effort' in cli, false);
  assert.equal('quiet' in cli, false);
});

test('CONFIG-HYDRATE preserves user overrides + is idempotent', () => {
  const cfg: any = { activeServer: '', servers: {}, cli: { llmMaxConcurrent: 1 } };
  const first = hydrateCliDefaults(cfg);
  assert.equal(first.config.cli?.llmMaxConcurrent, 1, 'user override kept, not reset to the default');
  assert.ok(first.added > 0);
  // A second pass over the now-complete config adds nothing.
  const second = hydrateCliDefaults(first.config);
  assert.equal(second.added, 0, 'idempotent — no churn on subsequent boots');
});
