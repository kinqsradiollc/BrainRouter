/**
 * The config file holds every local secret, so its MODE is part of its contract.
 *
 * `config.json` carries `llm.apiKey`, every `providers.*.apiKey`, the signed-in
 * account, per-repo PATs, web-search keys, trigger signing secrets, an inline
 * GitHub App private key and `cli.router.serveKey` — `scrubCliSecrets` exists
 * purely to keep that content away from the renderer, which is the clearest
 * statement of how sensitive it is.
 *
 * Without an explicit mode, Node applies `0o666 & ~umask`: 0600 under a umask of
 * 077, but 0644 under the far more common 022. Whether a credential file is
 * world-readable should not depend on an ambient process setting.
 *
 * These tests are only possible because the config directory is injectable via
 * `BRAINROUTER_CONFIG_DIR`. It was not, and the write path could then only be
 * exercised against the developer's real `~/.config/brainrouter/config.json` —
 * which is exactly how a real one got destroyed. A module you cannot point at a
 * temp directory is a module whose writes are untestable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = (target: string): string => (fs.statSync(target).mode & 0o777).toString(8);

async function withConfigDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const previous = process.env.BRAINROUTER_CONFIG_DIR;
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'br-config-')), 'brainrouter');
  process.env.BRAINROUTER_CONFIG_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.BRAINROUTER_CONFIG_DIR;
    else process.env.BRAINROUTER_CONFIG_DIR = previous;
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
}

test('the config directory is redirectable, so writes never touch the real one', async () => {
  await withConfigDir(async (dir) => {
    const { getConfigPath } = await import('../config/config.js');
    assert.equal(getConfigPath(), path.join(dir, 'config.json'));
    // The real path must NOT be what a test resolves — the whole point.
    assert.notEqual(getConfigPath(), path.join(os.homedir(), '.config', 'brainrouter', 'config.json'));
  });
});

test('a saved config is owner-only, whatever the umask says', async () => {
  await withConfigDir(async (dir) => {
    const { saveConfig } = await import('../config/config.js');
    saveConfig({ activeServer: 'probe', servers: {} } as never);
    const file = path.join(dir, 'config.json');
    assert.ok(fs.existsSync(file), 'the config was not written where it was directed');
    assert.equal(mode(file), '600', 'a file of credentials must not be group- or world-readable');
    assert.equal(mode(dir), '700', 'the directory must not be traversable by other local users');
  });
});

test('an existing world-readable config is repaired on the next save', async () => {
  await withConfigDir(async (dir) => {
    const { saveConfig } = await import('../config/config.js');
    const file = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '{"activeServer":"","servers":{}}', 'utf8');
    fs.chmodSync(file, 0o644);
    assert.equal(mode(file), '644');

    // `writeFileSync` PRESERVES the mode of an existing file, so without the
    // explicit chmod repair every config already on disk at 0644 would stay
    // 0644 forever — the fix would only protect fresh installs.
    saveConfig({ activeServer: 'probe', servers: {} } as never);
    assert.equal(mode(file), '600', 'an already-exposed config must be repaired, not left as found');
  });
});
