import test from 'node:test';
import assert from 'node:assert/strict';
import { selfHealConfig, type Config } from '@kinqs/brainrouter-core/config';
import { describeActiveServer } from '../cli/commands/serverStatus/index.js';
import { editableMcpStdioCommand } from '../cli/mcpUrl.js';
import { tryHandleUiStatusCommand } from '../cli/commands/ui/status.js';
import type { CommandContext } from '../cli/commands/_context.js';

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

test('describeActiveServer redacts credentials from legacy MCP endpoint URLs', () => {
  const rendered = describeActiveServer({
    activeServer: 'remote',
    servers: {
      remote: {
        type: 'http',
        url: 'https://user:password@example.test/mcp?token=query-secret#fragment-secret',
      },
    },
  }).join('\n');

  assert.doesNotMatch(rendered, /password|query-secret|fragment-secret|user:/);
  assert.match(rendered, /\?\[redacted\]/);
});

test('describeActiveServer redacts credentials from legacy stdio arguments', () => {
  const secrets = [
    'short-token',
    'url-password',
    'query-secret',
    'split-bearer-secret',
    'header-secret',
    'inline-header-prefix-secret',
  ];
  const rendered = describeActiveServer({
    activeServer: 'legacy',
    servers: {
      legacy: {
        type: 'stdio',
        command: 'connector',
        args: [
          '--token',
          secrets[0],
          `--endpoint=https://user:${secrets[1]}@example.test/mcp?token=${secrets[2]}`,
          'Bearer',
          secrets[3],
          '--header=Authorization:',
          'Bearer',
          secrets[4],
          '--header=Authorization: Bearer',
          secrets[5],
          '--private-key-path',
          '/safe/key.pem',
        ],
      },
    },
  }).join('\n');

  for (const secret of secrets) assert.doesNotMatch(rendered, new RegExp(secret));
  assert.match(rendered, /--token \[redacted\]/);
  assert.match(rendered, /--private-key-path \/safe\/key\.pem/);
  assert.match(rendered, /example\.test\/mcp\?\[redacted\]/);
});

test('/status redacts credentials from runtime-only MCP profiles', async () => {
  const runtimeSecret = 'runtime-only-status-secret';
  const diagnostic = {
    databaseStats: {
      userStats: {
        total: 0,
        byType: {},
        sensoryTotal: 1,
        sensoryUnextracted: 1,
        focusSceneTotal: 0,
        extraction: {
          syncPaused: true,
          extractionErrors: 5,
          lastErrorMessage: `transport rejected opaque value ${runtimeSecret}`,
        },
      },
    },
  };
  const context = {
    command: '/status',
    args: [],
    config: {
      activeServer: 'durable',
      servers: { durable: { type: 'http', url: 'https://example.test/mcp' } },
    },
    agent: {},
    mcpClient: {
      callTool: async (name: string) => name === 'memory_diagnostics'
        ? { content: [{ type: 'text', text: JSON.stringify(diagnostic) }] }
        : { content: [] },
    },
    repl: {
      launchPolicy: {},
      runtimeMcp: {
        servers: {
          runtime: { type: 'http', url: 'https://runtime.example.test/mcp', apiKey: runtimeSecret },
        },
      },
    },
  } as unknown as CommandContext;
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
  console.warn = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
  try {
    assert.equal(await tryHandleUiStatusCommand(context), true);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  const output = lines.join('\n');
  assert.doesNotMatch(output, new RegExp(runtimeSecret));
  assert.match(output, /\[redacted\]/);
});

test('stdio command editor never prefills inline credentials', () => {
  assert.equal(editableMcpStdioCommand({ command: 'connector', args: ['--token', 'secret'] }), '');
  assert.equal(
    editableMcpStdioCommand({ command: 'connector', args: ['--private-key-path', '/safe/key.pem'] }),
    'connector --private-key-path /safe/key.pem',
  );
});
