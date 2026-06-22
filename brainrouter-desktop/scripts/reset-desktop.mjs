#!/usr/bin/env node
/**
 * Clean-reset BrainRouter Desktop state so the app starts fresh for testing.
 *
 *   npm run reset:desktop            # DRY RUN — prints what would be reset
 *   npm run reset:desktop -- --yes   # apply
 *   npm run reset:desktop -- --yes --include-cli-state   # also reset GLOBAL CLI state (backed up first)
 *
 * Safe by default: only clears Electron desktop state (userData → localStorage,
 * IndexedDB, caches, recent-workspaces.json, UI prefs). It NEVER touches your
 * project files, and never touches the global CLI config / API keys / MCP /
 * transcripts (~/.brainrouter) unless you pass the dangerous --include-cli-state
 * flag — which makes a timestamped backup first.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const APP = pkg.name; // Electron app.getName() resolves to package.json "name" in dev

const args = process.argv.slice(2);
const YES = args.includes('--yes') || args.includes('-y');
const INCLUDE_CLI = args.includes('--include-cli-state');

function appDataBase() {
  // Test override so the integration test never touches the real user profile.
  if (process.env.BR_RESET_APPDATA_BASE) return process.env.BR_RESET_APPDATA_BASE;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

const userData = path.join(appDataBase(), APP);
const cliHome = process.env.BRAINROUTER_HOME || path.join(os.homedir(), '.brainrouter');
const listDir = (p) => { try { return fs.readdirSync(p); } catch { return null; } };

console.log('BrainRouter Desktop — clean reset\n');
console.log(`  app name:          ${APP}`);
console.log(`  Electron userData: ${userData}`);
const udEntries = listDir(userData);
console.log(`    ${udEntries === null ? '(does not exist)' : udEntries.length ? udEntries.join(', ') : '(empty)'}`);
if (INCLUDE_CLI) {
  console.log('\n  ⚠ --include-cli-state — will ALSO reset GLOBAL CLI state');
  console.log('    (config, API keys, MCP, trusted workspaces, sessions/transcripts):');
  console.log(`    ${cliHome}   (a timestamped backup is made first)`);
}

if (!YES) {
  console.log('\nDRY RUN — nothing was deleted.');
  console.log(`Apply with:  npm run reset:desktop -- --yes${INCLUDE_CLI ? ' --include-cli-state' : ''}`);
  process.exit(0);
}

const removed = [];
const skipped = [];
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

if (udEntries !== null) { rmrf(userData); removed.push(`Electron userData (localStorage, IndexedDB, caches, recents, UI prefs) → ${userData}`); }
else skipped.push(`Electron userData (already absent) → ${userData}`);

if (INCLUDE_CLI) {
  if (fs.existsSync(cliHome)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(path.dirname(cliHome), `${path.basename(cliHome)}.backup-${stamp}`);
    fs.cpSync(cliHome, backup, { recursive: true });
    rmrf(cliHome);
    removed.push(`CLI/global state → ${cliHome}  (backed up to ${backup})`);
  } else skipped.push(`CLI/global state (already absent) → ${cliHome}`);
}

console.log('\n✓ Reset complete.\n');
console.log('Removed:');
removed.length ? removed.forEach((r) => console.log(`  - ${r}`)) : console.log('  (nothing)');
if (skipped.length) { console.log('Skipped:'); skipped.forEach((s) => console.log(`  - ${s}`)); }
console.log('\nNOT touched: your project files' + (INCLUDE_CLI ? '.' : ', and CLI config / API keys / MCP / transcripts (use --include-cli-state to include those).'));
console.log('\nClean test sequence:\n  npm run reset:desktop -- --yes && npm start');
