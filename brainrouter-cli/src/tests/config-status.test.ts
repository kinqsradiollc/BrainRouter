import test from 'node:test';
import assert from 'node:assert/strict';
import { selfHealConfig, type Config } from '../config/config.js';
import { describeActiveServer } from '../cli/commands/serverStatus.js';

/**
 * Regression cover for GitHub issue #59 (`/status` crash:
 * "Cannot read properties of undefined (reading 'type')"). The root cause is a
 * config with `activeServer: ""` but populated `servers` — `servers[""]` is
 * undefined and `/status` read `.type` off it. Pure-function tests only — no
 * REPL/MCP boot — modeled on config-command.test.ts.
 */

// ---- selfHealConfig: #59 root cause (empty/dangling activeServer) ----------

test('selfHealConfig heals an empty activeServer to a brainrouter-identity profile (#59 root cause)', () => {
  const cfg: Config = {
    activeServer: '',
    servers: {
      'local-http': { type: 'http', url: 'http://a', identity: 'third-party' },
      'cloud': { type: 'http', url: 'http://b', identity: 'brainrouter' },
    },
  };
  const { config, changed } = selfHealConfig(cfg);
  assert.equal(config.activeServer, 'cloud', 'should prefer the brainrouter-identity profile');
  assert.equal(changed, true);
  // The crash precondition is now impossible: servers[activeServer] resolves.
  assert.ok(config.servers[config.activeServer], 'active profile must resolve after heal');
});

test('selfHealConfig heals empty activeServer by brainrouter-prefixed name when no identity tag', () => {
  const cfg: Config = {
    activeServer: '',
    servers: {
      'github': { type: 'http', url: 'http://a' },
      'brainrouter-local': { type: 'http', url: 'http://b' },
    },
  };
  assert.equal(selfHealConfig(cfg).config.activeServer, 'brainrouter-local');
});

test('selfHealConfig heals empty activeServer to the first profile as a last resort', () => {
  const cfg: Config = { activeServer: '', servers: { only: { type: 'stdio', command: 'x' } } };
  assert.equal(selfHealConfig(cfg).config.activeServer, 'only');
});

test('selfHealConfig heals a DANGLING activeServer (names a deleted profile)', () => {
  const cfg: Config = { activeServer: 'gone', servers: { present: { type: 'http', url: 'http://a' } } };
  assert.equal(selfHealConfig(cfg).config.activeServer, 'present');
});

test('selfHealConfig leaves a valid activeServer and a profile-less config untouched', () => {
  const valid: Config = { activeServer: 'a', servers: { a: { type: 'http', url: 'http://a' } } };
  const r = selfHealConfig(valid);
  assert.equal(r.config.activeServer, 'a');
  assert.equal(r.changed, false, 'a healthy config must not report changed');
  // empty servers + empty active: nothing to heal, activeServer stays '' (no throw)
  const empty: Config = { activeServer: '', servers: {} };
  assert.equal(selfHealConfig(empty).config.activeServer, '');
});

test('selfHealConfig does NOT inject cli.* defaults (preserves config > preference > default layering)', () => {
  // Writing default knob values into the file would make /effort and /theme
  // workspace preferences a silent no-op. selfHealConfig must leave cli alone.
  const cfg: Config = { activeServer: 'a', servers: { a: { type: 'http', url: 'http://a' } } };
  const { config } = selfHealConfig(cfg);
  assert.equal(config.cli, undefined, 'cli must stay undefined when the user never set it');

  const withOne: Config = { activeServer: 'a', servers: { a: { type: 'http', url: 'http://a' } }, cli: { maxToolLoops: 10 } };
  const healed = selfHealConfig(withOne).config;
  assert.deepEqual(healed.cli, { maxToolLoops: 10 }, 'must not add sibling defaults around a user-set knob');
});

// ---- describeActiveServer: the #59 crash guard -----------------------------

test('describeActiveServer does NOT throw when activeServer is empty (the exact #59 crash)', () => {
  const cfg: Config = { activeServer: '', servers: {} };
  let lines: string[] = [];
  assert.doesNotThrow(() => { lines = describeActiveServer(cfg); });
  assert.ok(lines.join('\n').includes('none configured'));
});

test('describeActiveServer does NOT throw when activeServer names a missing profile', () => {
  const cfg: Config = { activeServer: 'gone', servers: { other: { type: 'http', url: 'http://a' } } };
  let lines: string[] = [];
  assert.doesNotThrow(() => { lines = describeActiveServer(cfg); });
  assert.ok(lines.join('\n').includes('profile missing') || lines.join('\n').includes('gone'));
});

test('describeActiveServer renders http and stdio profiles', () => {
  const http = describeActiveServer({ activeServer: 'a', servers: { a: { type: 'http', url: 'http://x' } } }).join('\n');
  assert.ok(http.includes('http://x'), 'http profile shows the endpoint');
  const stdio = describeActiveServer({ activeServer: 'b', servers: { b: { type: 'stdio', command: 'run', args: ['--x'] } } }).join('\n');
  assert.ok(stdio.includes('stdio') && stdio.includes('run'), 'stdio profile shows the command');
});
