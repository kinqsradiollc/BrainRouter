import chalk from 'chalk';
import type { Config } from '../../config/config.js';

/**
 * Render the "Active Server" lines for `/status`. Pure (returns chalk-wrapped
 * strings; no console I/O), and deliberately kept in its own tiny module so it
 * can be unit-tested without importing the whole REPL/command graph.
 *
 * Guards GitHub issue #59: when `activeServer` is empty (the user's config had
 * `activeServer: ""`) or names a deleted profile, `config.servers[name]` is
 * `undefined`, and the old `/status` read `.type` straight off it — throwing
 * "Cannot read properties of undefined (reading 'type')". Mirror /doctor's
 * guard instead of dereferencing blindly. (The config self-heal in
 * `applyConfigDefaults` normally prevents an empty activeServer from ever
 * reaching here; this is the belt-and-suspenders for a truly profile-less or
 * dangling config.)
 */
export function describeActiveServer(config: Config): string[] {
  const name = config.activeServer;
  const server = config.servers?.[name];
  if (!server) {
    return [
      `  Active Server: ${chalk.yellow(name || '(none configured)')} ${chalk.red('— profile missing or activeServer is empty')}`,
      chalk.gray('  Run `/config` or `brainrouter login` to select a server profile.'),
    ];
  }
  const lines = [`  Active Server: ${chalk.green(name)} (Type: ${chalk.cyan(server.type)})`];
  if (server.type === 'http') {
    lines.push(`  Endpoint URL:  ${chalk.blue(server.url ?? '(unset)')}`);
  } else {
    lines.push(`  Command:       ${chalk.blue(server.command ?? '(unset)')} ${server.args?.join(' ') || ''}`);
  }
  return lines;
}
