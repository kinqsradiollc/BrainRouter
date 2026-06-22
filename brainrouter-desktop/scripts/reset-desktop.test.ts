import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reset-desktop.mjs');
const run = (args: string[], env: Record<string, string>) =>
  spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

function fixtures(): { base: string; userData: string; cliHome: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-base-'));
  const userData = path.join(base, 'brainrouter-desktop');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-workspaces.json'), '["/some/project"]');
  fs.mkdirSync(path.join(userData, 'Local Storage'), { recursive: true });
  const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-cli-'));
  fs.writeFileSync(path.join(cliHome, 'config.json'), '{"llm":{"apiKey":"secret"}}');
  return { base, userData, cliHome };
}

test('dry run (no --yes) deletes NOTHING', () => {
  const { base, userData, cliHome } = fixtures();
  const r = run([], { BR_RESET_APPDATA_BASE: base, BRAINROUTER_HOME: cliHome });
  assert.match(r.stdout, /DRY RUN/);
  assert.ok(fs.existsSync(userData), 'userData untouched in dry run');
  assert.ok(fs.existsSync(path.join(cliHome, 'config.json')), 'cli config untouched in dry run');
});

test('--yes removes Electron userData (desktop state)', () => {
  const { base, userData, cliHome } = fixtures();
  const r = run(['--yes'], { BR_RESET_APPDATA_BASE: base, BRAINROUTER_HOME: cliHome });
  assert.match(r.stdout, /Reset complete/);
  assert.equal(fs.existsSync(userData), false, 'userData removed');
});

test('--yes does NOT touch CLI/global state without --include-cli-state', () => {
  const { base, cliHome } = fixtures();
  run(['--yes'], { BR_RESET_APPDATA_BASE: base, BRAINROUTER_HOME: cliHome });
  assert.ok(fs.existsSync(path.join(cliHome, 'config.json')), 'CLI config (API keys) preserved');
});

test('--include-cli-state backs up THEN removes CLI/global state', () => {
  const { base, cliHome } = fixtures();
  run(['--yes', '--include-cli-state'], { BR_RESET_APPDATA_BASE: base, BRAINROUTER_HOME: cliHome });
  assert.equal(fs.existsSync(cliHome), false, 'CLI home removed');
  const backup = fs.readdirSync(path.dirname(cliHome)).find((n) => n.startsWith(`${path.basename(cliHome)}.backup-`));
  assert.ok(backup, 'timestamped backup was created before removal');
  assert.ok(fs.existsSync(path.join(path.dirname(cliHome), backup!, 'config.json')), 'backup contains the config');
});
