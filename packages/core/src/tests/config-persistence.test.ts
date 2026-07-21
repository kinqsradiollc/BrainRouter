import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('saveConfigOrThrow atomically persists private config with mode 0600', { skip: process.platform === 'win32' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-config-home-'));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const { getConfigPath, saveConfigOrThrow } = await import('../config/config.js');
    const configPath = getConfigPath();

    saveConfigOrThrow({
      activeServer: '',
      servers: {},
      llm: { provider: 'openai', apiKey: 'private-test-key', model: 'test-model' },
    });
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).llm.apiKey, 'private-test-key');
    assert.deepEqual(
      fs.readdirSync(path.dirname(configPath)).filter((name) => name.endsWith('.tmp')),
      [],
      'the atomic writer leaves no staging files behind',
    );

    fs.chmodSync(configPath, 0o644);
    saveConfigOrThrow({ activeServer: '', servers: {} });
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600, 'replacement tightens an unsafe prior mode');
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { activeServer: '', servers: {} });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
