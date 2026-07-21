import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAutomationKnob,
  applyProviderRequestFormat,
  buildScrubbedConfigJson,
  listKnownConfigKeys,
  listProviderRequestFormatRows,
  parseConfigArgs,
  parseSchemaValue,
  readAutomationKnob,
  formatSchemaValue,
  WIRE_FORMAT_OPTIONS,
} from '../cli/commands/config/index.js';
import { findConfigSchemaField } from '@kinqs/brainrouter-core/config';

const emptyConfig = (): any => ({ activeServer: '', servers: {} });

test('parseConfigArgs: no args → home panel', () => {
  assert.deepEqual(parseConfigArgs([]), { mode: 'home' });
});

test('parseConfigArgs: raw / --raw / json all route to the raw dump', () => {
  assert.deepEqual(parseConfigArgs(['raw']), { mode: 'raw' });
  assert.deepEqual(parseConfigArgs(['--raw']), { mode: 'raw' });
  assert.deepEqual(parseConfigArgs(['json']), { mode: 'raw' });
});

test('parseConfigArgs: single arg → get for that key (lowercased)', () => {
  assert.deepEqual(parseConfigArgs(['theme']), { mode: 'get', key: 'theme' });
  assert.deepEqual(parseConfigArgs(['THEME']), { mode: 'get', key: 'theme' });
});

test('parseConfigArgs: key + value → set, with the value joined back on space', () => {
  assert.deepEqual(parseConfigArgs(['theme', 'dark']), {
    mode: 'set', key: 'theme', value: 'dark',
  });
  assert.deepEqual(parseConfigArgs(['statusline', 'mode,branch,workflow']), {
    mode: 'set', key: 'statusline', value: 'mode,branch,workflow',
  });
});

test('parseConfigArgs: trailing whitespace is trimmed off the value', () => {
  assert.deepEqual(parseConfigArgs(['theme', '  dark  ']), {
    mode: 'set', key: 'theme', value: 'dark',
  });
});

test('listKnownConfigKeys exposes the keys /config can get/set directly', () => {
  const keys = listKnownConfigKeys();
  // Core knobs every user touches.
  for (const required of ['theme', 'statusline', 'effort', 'mode', 'review-policy', 'quiet', 'personality', 'editor', 'model', 'provider']) {
    assert.ok(keys.includes(required), `/config should support ${required}`);
  }
});

test('listKnownConfigKeys exposes the workflow-automation keys', () => {
  const keys = listKnownConfigKeys();
  for (const required of ['automation', 'automation.requirements', 'automation.sync', 'automation.sprints']) {
    assert.ok(keys.includes(required), `/config should support ${required}`);
  }
});

test('listKnownConfigKeys exposes schema-driven cli knobs', () => {
  const keys = listKnownConfigKeys();
  for (const required of ['maxOutputTokens', 'budget.maxPerTaskTokens', 'notifyBell']) {
    assert.ok(keys.includes(required), `/config should support schema key ${required}`);
  }
});

test('schema renderer maps field types to CLI values and parsers', () => {
  const numberField = findConfigSchemaField('budget.maxPerTaskTokens')!;
  const boolField = findConfigSchemaField('notifyBell')!;
  const selectField = findConfigSchemaField('nextActionPlanner')!;
  assert.equal(formatSchemaValue(numberField, undefined), '0');
  assert.deepEqual(parseSchemaValue(numberField, '42'), { ok: true, message: 'budget.maxPerTaskTokens → 42', value: 42 });
  assert.deepEqual(parseSchemaValue(boolField, 'on'), { ok: true, message: 'notifyBell → on', value: true });
  assert.deepEqual(parseSchemaValue(selectField, 'off'), { ok: true, message: 'nextActionPlanner → off', value: 'off' });
  assert.equal(parseSchemaValue(selectField, 'maybe').ok, false);
});

test('listProviderRequestFormatRows keys saved providers by runtime provider id', () => {
  const cfg = emptyConfig();
  cfg.providers = {
    prod: { provider: 'OpenAI', model: 'gpt-4.1', apiKey: 'x' },
    local: { provider: 'lmstudio', model: 'gpt-4.1', apiKey: '' },
    anotherOpenAI: { provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'x' },
  };
  const rows = listProviderRequestFormatRows(cfg);
  const openaiRows = rows.filter((r) => r.id === 'openai');
  assert.equal(openaiRows.length, 1);
  assert.deepEqual(openaiRows[0].savedNames, ['prod', 'anotherOpenAI']);
  assert.ok(rows.some((r) => r.id === 'lmstudio' && r.savedNames.includes('local')));
});

test('applyProviderRequestFormat persists lowercase overrides and default clears only that key', () => {
  const cfg = emptyConfig();
  cfg.cli = { providerRequestFormat: { openrouter: 'chat-completions' } };
  assert.deepEqual(WIRE_FORMAT_OPTIONS, ['default', 'chat-completions', 'responses', 'anthropic-messages', 'gemini-generate']);
  assert.deepEqual(applyProviderRequestFormat(cfg, 'OpenAI', 'responses'), { ok: true });
  assert.deepEqual(cfg.cli.providerRequestFormat, { openrouter: 'chat-completions', openai: 'responses' });
  // Native wire formats persist for their providers too.
  assert.deepEqual(applyProviderRequestFormat(cfg, 'Anthropic', 'anthropic-messages'), { ok: true });
  assert.equal(cfg.cli.providerRequestFormat?.anthropic, 'anthropic-messages');
  assert.deepEqual(applyProviderRequestFormat(cfg, 'anthropic', 'default'), { ok: true });

  assert.deepEqual(applyProviderRequestFormat(cfg, 'openai', 'default'), { ok: true });
  assert.deepEqual(cfg.cli.providerRequestFormat, { openrouter: 'chat-completions' });

  assert.deepEqual(applyProviderRequestFormat(cfg, 'openrouter', 'default'), { ok: true });
  assert.equal(cfg.cli.providerRequestFormat, undefined);
});

test('applyAutomationKnob: master toggle on/off, rejects garbage', () => {
  const cfg = emptyConfig();
  assert.deepEqual(applyAutomationKnob(cfg, 'automation', 'on').ok, true);
  assert.equal(cfg.cli.automation.enabled, true);
  assert.deepEqual(applyAutomationKnob(cfg, 'automation', 'off').ok, true);
  assert.equal(cfg.cli.automation.enabled, false);
  const bad = applyAutomationKnob(cfg, 'automation', 'maybe');
  assert.equal(bad.ok, false);
});

test('applyAutomationKnob: requirements tier maps off/propose/autopilot', () => {
  const cfg = emptyConfig();
  applyAutomationKnob(cfg, 'automation.requirements', 'autopilot');
  assert.deepEqual(cfg.cli.automation.requirements, { enabled: true, autopilot: true });
  applyAutomationKnob(cfg, 'automation.requirements', 'propose');
  assert.deepEqual(cfg.cli.automation.requirements, { enabled: true, autopilot: false });
  applyAutomationKnob(cfg, 'automation.requirements', 'on'); // alias for propose
  assert.equal(cfg.cli.automation.requirements.autopilot, false);
  applyAutomationKnob(cfg, 'automation.requirements', 'off');
  assert.equal(cfg.cli.automation.requirements.enabled, false);
  assert.equal(applyAutomationKnob(cfg, 'automation.requirements', 'turbo').ok, false);
});

test('applyAutomationKnob: sync boolean + sprints tier', () => {
  const cfg = emptyConfig();
  applyAutomationKnob(cfg, 'automation.sync', 'on');
  assert.equal(cfg.cli.automation.sync.enabled, true);
  applyAutomationKnob(cfg, 'automation.sprints', 'autopilot');
  assert.deepEqual(cfg.cli.automation.sprints, { enabled: true, autopilot: true });
  assert.equal(applyAutomationKnob(cfg, 'automation.sprints', 'nope').ok, false);
});

test('readAutomationKnob reflects the applied state', () => {
  const cfg = emptyConfig();
  assert.equal(readAutomationKnob(cfg, 'automation'), 'off');
  assert.equal(readAutomationKnob(cfg, 'automation.requirements'), 'off');
  applyAutomationKnob(cfg, 'automation', 'on');
  applyAutomationKnob(cfg, 'automation.requirements', 'autopilot');
  applyAutomationKnob(cfg, 'automation.sprints', 'propose');
  assert.equal(readAutomationKnob(cfg, 'automation'), 'on');
  assert.equal(readAutomationKnob(cfg, 'automation.requirements'), 'autopilot');
  assert.equal(readAutomationKnob(cfg, 'automation.sprints'), 'propose');
});

test('buildScrubbedConfigJson masks LLM and MCP API keys', () => {
  const out = buildScrubbedConfigJson({
    activeServer: 'remote',
    llm: {
      provider: 'openai',
      endpoint: 'https://user:llm-password@api.openai.com/v1?api_key=llm-query-secret',
      model: 'gpt-5',
      apiKey: 'sk-test-1234567890',
    },
    servers: {
      remote: {
        type: 'http',
        url: 'https://user:password@brainrouter.example/mcp/token%25252Fabc1234567890ABCDEF1234567890abcdef?token=query-secret',
        apiKey: 'brainrouter_remote_abcdef123456',
        env: {
          BRAINROUTER_API_KEY: 'brainrouter_env_abcdef123456',
          GITHUB_TOKEN: 'github_pat_abcdef1234567890',
          CUSTOM_PASSWORD: 'custom-password-value',
          AWS_SECRET_ACCESS_KEY: 'aws-secret-access-value',
          PRIVATE_KEY: 'private-key-value',
          DATABASE_URL: 'postgres://dbuser:db-password@example.test/app',
        },
        headers: {
          Authorization: 'Bearer header-secret-value',
          'X-Amz-Signature': 'signature-secret-value',
        },
      },
    },
  } as any);

  assert.doesNotMatch(out, /sk-test-1234567890/);
  assert.doesNotMatch(out, /brainrouter_remote_abcdef123456/);
  assert.doesNotMatch(out, /brainrouter_env_abcdef123456/);
  assert.doesNotMatch(out, /github_pat_abcdef1234567890|custom-password-value/);
  assert.doesNotMatch(out, /aws-secret-access-value|private-key-value|db-password/);
  assert.doesNotMatch(out, /header-secret-value|signature-secret-value/);
  assert.doesNotMatch(out, /llm-password|llm-query-secret/);
  assert.doesNotMatch(out, /password|query-secret|abc1234567890/);
  assert.match(out, /\[redacted\]/);
  assert.match(out, /7890/);
  assert.match(out, /3456/);
});

test('buildScrubbedConfigJson recursively scrubs onboarding and integration credentials', () => {
  const out = buildScrubbedConfigJson({
    activeServer: '',
    llm: {
      provider: 'openai',
      endpoint: 'https://llm-user:llm-pass@example.test/v1?api_key=llm-query-secret',
      model: 'gpt-5',
      apiKey: 'sk-recursive-1234567890',
    },
    providers: {
      managed: {
        provider: 'openai',
        endpoint: 'https://provider-user:provider-pass@example.test/v1?token=provider-query-secret',
        model: 'gpt-5',
        apiKey: 'provider-key-1234567890',
      },
    },
    cli: {
      brainUrl: 'https://brain-user:brain-pass@example.test/api?token=brain-query-secret',
      router: { serveKey: 'router-serve-key-secret' },
      tracingApiKey: 'tracing-api-key-secret',
      tracingEndpoint: 'https://trace-user:trace-pass@example.test/v1?sig=trace-query-secret',
      webSearch: {
        serperApiKey: 'serper-api-key-secret',
        braveApiKey: 'brave-api-key-secret',
        google: { apiKey: 'google-api-key-secret', cx: 'visible-search-engine-id' },
        searxngBaseUrl: 'https://search-user:search-pass@example.test/search?token=search-query-secret',
      },
      triggers: {
        githubApp: {
          privateKey: '-----BEGIN PRIVATE KEY-----inline-private-key-secret-----END PRIVATE KEY-----',
          privateKeyPath: '/Users/example/.keys/github-app.pem',
          apiBase: 'https://github-user:github-pass@example.test/api?token=github-query-secret',
        },
        githubSecret: 'github-webhook-secret',
        slackSigningSecret: 'slack-signing-secret',
        gitlabSecret: 'gitlab-webhook-secret',
        jiraSecret: 'jira-webhook-secret',
      },
      track: {
        githubToken: 'github_pat_global1234567890',
        githubRepos: [{
          repo: 'owner/repo',
          token: 'github_pat_repo1234567890',
        }],
        githubCaBundle: '/etc/ssl/certs/github-ca.pem',
      },
      github: { caBundle: '/etc/ssl/certs/corporate-ca.pem' },
      plugins: {
        registryUrl: '/var/lib/brainrouter/registry.json',
        marketplaces: [{
          name: 'private',
          sourceType: 'git',
          source: 'https://market-user:market-pass@example.test/catalog?token=market-query-secret',
        }],
      },
    },
    servers: {},
  } as any);
  const parsed = JSON.parse(out);

  for (const secret of [
    'router-serve-key-secret',
    'tracing-api-key-secret',
    'serper-api-key-secret',
    'brave-api-key-secret',
    'google-api-key-secret',
    'inline-private-key-secret',
    'github-webhook-secret',
    'slack-signing-secret',
    'gitlab-webhook-secret',
    'jira-webhook-secret',
    'github_pat_global1234567890',
    'github_pat_repo1234567890',
  ]) {
    assert.equal(out.includes(secret), false, `raw config must not include ${secret}`);
  }
  assert.doesNotMatch(out, /(?:llm|provider|brain|trace|search|github|market)-(?:user|pass|query-secret)/);
  assert.equal(parsed.cli.triggers.githubApp.privateKeyPath, '/Users/example/.keys/github-app.pem');
  assert.equal(parsed.cli.track.githubCaBundle, '/etc/ssl/certs/github-ca.pem');
  assert.equal(parsed.cli.github.caBundle, '/etc/ssl/certs/corporate-ca.pem');
  assert.equal(parsed.cli.plugins.registryUrl, '/var/lib/brainrouter/registry.json');
  assert.equal(parsed.cli.webSearch.google.cx, 'visible-search-engine-id');
  assert.match(parsed.cli.triggers.githubApp.apiBase, /\[redacted\]/);
  assert.match(parsed.cli.plugins.marketplaces[0].source, /\[redacted\]/);
});

test('buildScrubbedConfigJson scrubs MCP maps and secret-bearing stdio args without hiding paths', () => {
  const out = buildScrubbedConfigJson({
    activeServer: 'local',
    servers: {
      local: {
        type: 'stdio',
        command: 'node',
        args: [
          '--root',
          '/Users/example/project',
          '--token',
          'stdio-token-secret',
          '--api-key=inline-stdio-secret',
          'GITHUB_TOKEN=github-arg-secret',
          '--endpoint=https://arg-user:arg-pass@example.test/v1?token=arg-query-secret',
          '--private-key-path',
          '/Users/example/.keys/service.pem',
          '--ca-bundle=/etc/ssl/certs/service-ca.pem',
          'Authorization: Bearer argument-header-secret',
          '--header',
          'Authorization:',
          'Bearer',
          'split-header-secret',
          'plain-argument',
        ],
        env: {
          PROJECT_ID: 'non-secret-map-value',
          SERVICE_TOKEN: 'stdio-env-secret',
        },
        headers: {
          Authorization: 'Bearer stdio-header-secret',
          'X-Workspace': 'non-secret-header-value',
        },
      },
    },
  } as any);
  const parsed = JSON.parse(out);
  const args = parsed.servers.local.args as string[];

  assert.doesNotMatch(out, /stdio-token-secret|inline-stdio-secret|github-arg-secret/);
  assert.doesNotMatch(out, /arg-user|arg-pass|arg-query-secret|argument-header-secret|split-header-secret/);
  assert.doesNotMatch(out, /non-secret-map-value|stdio-env-secret|stdio-header-secret|non-secret-header-value/);
  assert.deepEqual(args.slice(0, 2), ['--root', '/Users/example/project']);
  assert.equal(args[7], '--private-key-path');
  assert.equal(args[8], '/Users/example/.keys/service.pem');
  assert.equal(args[9], '--ca-bundle=/etc/ssl/certs/service-ca.pem');
  assert.equal(args[15], 'plain-argument');
  assert.match(args[6], /\[redacted\]/);
});
