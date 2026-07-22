/**
 * Regression coverage for complete BrainRouter logout credential removal.
 * The tests pin both every legacy transport location and the exact rollback
 * contract when the atomic config write cannot be committed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '@kinqs/brainrouter-core/config';
import type { CommandContext } from '../cli/commands/_context.js';
import { tryHandleGuardCommand } from '../cli/commands/guard/index.js';
import {
  clearBrainrouterCredentials,
  persistBrainrouterLogout,
} from '../cli/commands/guard/logoutCredentials.js';

function credentialedConfig(): Config {
  return {
    activeServer: 'tools',
    activeBrainrouterServer: 'brain',
    servers: {
      tools: { type: 'http', url: 'https://tools.example.com/mcp' },
      brain: {
        type: 'stdio',
        command: 'brainrouter-mcp',
        apiKey: 'server-secret',
        headers: {
          Authorization: 'Bearer header-secret',
          'X-Api-Key': 'header-api-secret',
          Cookie: 'session=header-cookie',
          'X-Workspace': 'engineering',
        },
        env: {
          BRAINROUTER_API_KEY: 'env-secret',
          ACCESS_TOKEN: 'env-token',
          PATH: '/usr/local/bin:/usr/bin',
          PRIVATE_KEY_PATH: '/Users/example/.keys/service.pem',
          TOKEN_FILE: '/Users/example/.tokens/service.txt',
        },
        args: [
          '--api-key',
          'argument-secret',
          '--header=Authorization:',
          'Bearer',
          'header-argument-secret',
          '--private-key-path',
          '/Users/example/.keys/service.pem',
          '--token-file',
          '/Users/example/.tokens/service.txt',
          '--root',
          '/Users/example/project',
        ],
        identity: 'brainrouter',
      },
    },
    llm: {
      provider: 'openai',
      apiKey: 'llm-secret',
      model: 'gpt-test',
      endpoint: 'https://api.example.com/v1',
    },
  };
}

test('BrainRouter logout removes every credential location while preserving safe transport arguments', () => {
  const config = credentialedConfig();
  const sourceServer = config.servers.brain!;
  const sourceLlm = config.llm!;
  const projected = clearBrainrouterCredentials(sourceServer, sourceLlm);

  assert.equal(sourceServer.apiKey, 'server-secret', 'the pure projection must not mutate its source profile');
  assert.equal(sourceLlm.apiKey, 'llm-secret', 'the pure projection must not mutate its source LLM config');
  assert.equal(projected.server.apiKey, undefined);
  assert.deepEqual(projected.server.headers, { 'X-Workspace': 'engineering' });
  assert.deepEqual(projected.server.env, {
    PATH: '/usr/local/bin:/usr/bin',
    PRIVATE_KEY_PATH: '/Users/example/.keys/service.pem',
    TOKEN_FILE: '/Users/example/.tokens/service.txt',
  });
  assert.deepEqual(projected.server.args, [
    '--private-key-path',
    '/Users/example/.keys/service.pem',
    '--token-file',
    '/Users/example/.tokens/service.txt',
    '--root',
    '/Users/example/project',
  ]);
  assert.equal(projected.llm?.apiKey, '');
  assert.deepEqual(projected.removed, [
    'server.apiKey',
    'server.headers.Authorization',
    'server.headers.X-Api-Key',
    'server.headers.Cookie',
    'server.env.BRAINROUTER_API_KEY',
    'server.env.ACCESS_TOKEN',
    'server.args',
    'llm.apiKey',
  ]);
});

test('BrainRouter logout restores the exact prior records when persistence fails', () => {
  const config = credentialedConfig();
  const before = structuredClone(config);
  const serverReference = config.servers.brain;
  const llmReference = config.llm;
  let persistenceSawClearedCredentials = false;

  assert.throws(() => persistBrainrouterLogout(config, 'brain', (candidate) => {
    persistenceSawClearedCredentials = candidate !== config
      && candidate.servers.brain?.apiKey === undefined
      && candidate.servers.brain?.headers?.Authorization === undefined
      && candidate.servers.brain?.env?.BRAINROUTER_API_KEY === undefined
      && !candidate.servers.brain?.args?.includes('argument-secret')
      && candidate.llm?.apiKey === '';
    throw new Error('config write denied');
  }), /config write denied/);

  assert.equal(persistenceSawClearedCredentials, true, 'the strict writer receives the complete logged-out projection');
  assert.deepEqual(config, before, 'every credential location is restored on write failure');
  assert.strictEqual(config.servers.brain, serverReference, 'the original server record identity is restored');
  assert.strictEqual(config.llm, llmReference, 'the original LLM record identity is restored');
});

test('/logout updates runtime credentials and the live Agent only after persistence, then removes the live profile', async () => {
  const config = credentialedConfig();
  const runtimePeer = { type: 'http' as const, url: 'https://tools.example.com/mcp' };
  const events: string[] = [];
  const context = {
    command: '/logout',
    args: [],
    config,
    agent: {
      setLLMConfig: (llm: Config['llm']) => {
        events.push('agent');
        assert.equal(llm?.apiKey, '');
      },
    },
    mcpClient: {
      removeOne: async (profile: string) => {
        events.push(`remove:${profile}`);
      },
    },
    repl: {
      runtimeMcp: {
        servers: {
          brain: structuredClone(config.servers.brain!),
          tools: runtimePeer,
        },
        activeServer: 'tools',
        activeBrainrouterServer: 'brain',
      },
    },
  } as unknown as CommandContext;
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    const handled = await tryHandleGuardCommand(context, {
      persistLogout: (candidate, profile) => persistBrainrouterLogout(candidate, profile, () => {
        events.push('persist');
      }),
    });
    assert.equal(handled, true);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(events, ['persist', 'agent', 'remove:brain']);
  assert.strictEqual(context.repl.runtimeMcp?.servers.tools, runtimePeer, 'unrelated runtime profiles are preserved');
  assert.equal(context.repl.runtimeMcp?.activeServer, 'tools');
  assert.equal(context.repl.runtimeMcp?.activeBrainrouterServer, 'brain');
  assert.deepEqual(context.repl.runtimeMcp?.servers.brain, config.servers.brain);
  assert.equal(context.repl.runtimeMcp?.servers.brain?.apiKey, undefined);
  assert.equal(context.repl.runtimeMcp?.servers.brain?.env?.BRAINROUTER_API_KEY, undefined);
});

test('/logout keeps the durable logout when live removal fails and redacts both durable and runtime secrets', async () => {
  const config = credentialedConfig();
  const runtimeSecret = 'runtime-launch-secret';
  const lines: string[] = [];
  const context = {
    command: '/logout',
    args: [],
    config,
    agent: { setLLMConfig: () => undefined },
    mcpClient: {
      removeOne: async () => {
        throw new Error(`close failed for server-secret and ${runtimeSecret}`);
      },
    },
    repl: {
      runtimeMcp: {
        servers: {
          brain: { ...structuredClone(config.servers.brain!), apiKey: runtimeSecret },
        },
        activeServer: 'brain',
        activeBrainrouterServer: 'brain',
      },
    },
  } as unknown as CommandContext;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
  try {
    await tryHandleGuardCommand(context, {
      persistLogout: (candidate, profile) => persistBrainrouterLogout(candidate, profile, () => undefined),
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(config.servers.brain?.apiKey, undefined, 'disconnect failure does not roll back durable logout');
  assert.equal(context.repl.runtimeMcp?.servers.brain?.apiKey, undefined);
  assert.match(lines.join('\n'), /live profile could not be disconnected/);
  assert.doesNotMatch(lines.join('\n'), /server-secret|runtime-launch-secret/);
});

test('/logout redacts durable and runtime credentials from persistence errors', async () => {
  const config = credentialedConfig();
  const runtimeSecret = 'runtime-persist-secret';
  const lines: string[] = [];
  const context = {
    command: '/logout',
    args: [],
    config,
    agent: { setLLMConfig: () => undefined },
    mcpClient: { removeOne: async () => undefined },
    repl: {
      runtimeMcp: {
        servers: {
          brain: { ...structuredClone(config.servers.brain!), apiKey: runtimeSecret },
        },
        activeServer: 'brain',
        activeBrainrouterServer: 'brain',
      },
    },
  } as unknown as CommandContext;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
  try {
    await tryHandleGuardCommand(context, {
      persistLogout: () => {
        throw new Error(`write rejected for server-secret and ${runtimeSecret}`);
      },
    });
  } finally {
    console.log = originalLog;
  }

  assert.match(lines.join('\n'), /Could not persist logout/);
  assert.doesNotMatch(lines.join('\n'), /server-secret|runtime-persist-secret/);
});

test('/logout invalidates a stale runtime credential even when the durable profile is already clear', async () => {
  const config = credentialedConfig();
  config.servers.brain = clearBrainrouterCredentials(config.servers.brain!, undefined).server;
  config.llm = { ...config.llm!, apiKey: '' };
  const durableBefore = structuredClone(config);
  let removedLive = false;
  const context = {
    command: '/logout',
    args: [],
    config,
    agent: { setLLMConfig: () => assert.fail('an already-clear LLM must not be updated') },
    mcpClient: { removeOne: async () => { removedLive = true; } },
    repl: {
      runtimeMcp: {
        servers: {
          brain: { ...structuredClone(config.servers.brain!), apiKey: 'stale-launch-secret' },
        },
        activeBrainrouterServer: 'brain',
      },
    },
  } as unknown as CommandContext;
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
  try {
    await tryHandleGuardCommand(context, {
      persistLogout: (candidate, profile) => persistBrainrouterLogout(candidate, profile, () => {
        assert.fail('an unchanged durable config must not be rewritten');
      }),
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(config, durableBefore);
  assert.equal(context.repl.runtimeMcp?.servers.brain?.apiKey, undefined);
  assert.equal(removedLive, true);
  assert.match(lines.join('\n'), /runtime\.apiKey/);
});

test('/logout supports a runtime-only selected brain without creating a durable profile', async () => {
  const config: Config = {
    activeServer: 'tools',
    servers: {
      tools: { type: 'http', url: 'https://tools.example.com/mcp', identity: 'third-party' },
    },
    llm: {
      provider: 'openai',
      apiKey: 'llm-runtime-session-secret',
      model: 'gpt-test',
    },
  };
  const events: string[] = [];
  const context = {
    command: '/logout',
    args: [],
    config,
    agent: { setLLMConfig: () => { events.push('agent'); } },
    mcpClient: { removeOne: async (profile: string) => { events.push(`remove:${profile}`); } },
    repl: {
      runtimeMcp: {
        servers: {
          brainrouter: {
            type: 'http',
            url: 'https://brain.example.com/mcp',
            apiKey: 'runtime-only-secret',
            identity: 'brainrouter',
          },
        },
        activeServer: 'tools',
        activeBrainrouterServer: 'brainrouter',
      },
    },
  } as unknown as CommandContext;
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await tryHandleGuardCommand(context, {
      persistLogout: (candidate, profile) => persistBrainrouterLogout(candidate, profile, () => {
        events.push('persist');
      }),
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(events, ['persist', 'agent', 'remove:brainrouter']);
  assert.equal(Object.prototype.hasOwnProperty.call(config.servers, 'brainrouter'), false);
  assert.equal(config.llm?.apiKey, '');
  assert.equal(context.repl.runtimeMcp?.servers.brainrouter?.apiKey, undefined);
  assert.equal(context.repl.runtimeMcp?.activeBrainrouterServer, 'brainrouter');
});
