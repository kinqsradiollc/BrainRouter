// `brainrouter github login | logout | status` — connect GitHub to your BrainRouter
// account from the terminal, the same way `claude auth login` works. This is a THIN
// client over the backend's server-mediated broker: the device flow runs against the
// bundled BrainRouter GitHub App and the resulting token is sealed *on the server*,
// keyed to your account. The CLI never sees or stores a GitHub token — it only kicks
// off the device flow and polls for completion. Requires an active hosted (http)
// profile (run `brainrouter login` first); the profile's API key authenticates you.
import type { Command } from 'commander';
import chalk from 'chalk';
import { loadOrInitConfig } from '@kinqs/brainrouter-core/config';

interface HttpTarget { baseUrl: string; apiKey: string }

/** Resolve the active hosted profile → the backend base URL + API key, or an error. */
function resolveHttpTarget(): HttpTarget | { error: string } {
  const config = loadOrInitConfig();
  const active = config.activeServer;
  const server = active ? config.servers?.[active] : undefined;
  if (!server || server.type !== 'http' || !('url' in server) || !server.url) {
    return { error: 'No hosted BrainRouter server is configured. Run `brainrouter login` to connect to one first.' };
  }
  // The profile URL is the MCP endpoint (…/mcp); the connector API lives at the root.
  const baseUrl = String(server.url).replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
  const apiKey = String(('apiKey' in server && server.apiKey) || '');
  if (!apiKey) return { error: 'Your BrainRouter profile has no API key. Re-run `brainrouter login`.' };
  return { baseUrl, apiKey };
}

const authHeaders = (apiKey: string): Record<string, string> => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errMsg = (o: unknown): string => {
  const r = o as { error?: unknown; message?: unknown };
  if (typeof r?.error === 'string') return r.error;
  const em = (r?.error as { message?: unknown })?.message;
  return (typeof em === 'string' ? em : '') || (typeof r?.message === 'string' ? r.message : '') || '';
};

async function githubLogin(t: HttpTarget): Promise<void> {
  const startRes = await fetch(`${t.baseUrl}/api/connectors/github/device/start`, { method: 'POST', headers: authHeaders(t.apiKey) });
  const start = await startRes.json().catch(() => ({})) as { userCode?: string; verificationUri?: string; interval?: number };
  if (!startRes.ok || !start.userCode) {
    console.error(chalk.red(`\n✖ Could not start GitHub sign-in: ${errMsg(start) || `HTTP ${startRes.status}`}`));
    process.exitCode = 1; return;
  }
  const uri = start.verificationUri || 'https://github.com/login/device';
  const interval = Number(start.interval) > 0 ? Number(start.interval) : 5;

  console.log(chalk.bold.hex('#8B7CFF')('\nConnect GitHub'));
  console.log(`\n  1. Open  ${chalk.cyan(uri)}`);
  console.log(`  2. Enter the code:  ${chalk.bold.green(start.userCode)}\n`);
  console.log(chalk.gray('Waiting for you to authorize in the browser… (Ctrl-C to cancel)'));

  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const pollRes = await fetch(`${t.baseUrl}/api/connectors/github/device/poll`, { method: 'POST', headers: authHeaders(t.apiKey) });
    const poll = await pollRes.json().catch(() => ({})) as { status?: string; login?: string; error?: string };
    if (poll.status === 'pending') continue;
    if (poll.status === 'connected') { console.log(chalk.green(`\n✔ GitHub connected as ${chalk.bold(poll.login || 'your account')}.`)); return; }
    if (poll.status === 'expired') { console.error(chalk.red('\n✖ The code expired before you authorized it. Run `brainrouter github login` again.')); process.exitCode = 1; return; }
    console.error(chalk.red(`\n✖ GitHub sign-in failed: ${poll.error || 'unknown error'}`)); process.exitCode = 1; return;
  }
  console.error(chalk.red('\n✖ Timed out waiting for authorization.')); process.exitCode = 1;
}

async function githubLogout(t: HttpTarget): Promise<void> {
  const r = await fetch(`${t.baseUrl}/api/connectors/github/disconnect`, { method: 'POST', headers: authHeaders(t.apiKey) });
  if (r.ok) console.log(chalk.green('✔ GitHub disconnected.'));
  else { console.error(chalk.red(`✖ Could not disconnect: HTTP ${r.status}`)); process.exitCode = 1; }
}

async function githubStatus(t: HttpTarget): Promise<void> {
  const r = await fetch(`${t.baseUrl}/api/connectors/github/status`, { headers: authHeaders(t.apiKey) });
  const d = await r.json().catch(() => ({})) as { connected?: boolean; login?: string; installUrl?: string };
  if (!r.ok) { console.error(chalk.red(`✖ Could not read GitHub status: HTTP ${r.status}`)); process.exitCode = 1; return; }
  if (d.connected) console.log(chalk.green(`✔ GitHub connected${d.login ? ` as ${chalk.bold(d.login)}` : ''}.`));
  else console.log(`${chalk.yellow('GitHub is not connected.')}${chalk.gray('  Run `brainrouter github login`.')}`);
  if (d.installUrl) console.log(chalk.gray(`  Manage which repos BrainRouter can see: ${d.installUrl}`));
}

export function registerGithubCommand(program: Command): void {
  program
    .command('github <action>')
    .description('Connect GitHub to your BrainRouter account: login | logout | status')
    .action(async (action: string) => {
      const act = String(action ?? '').toLowerCase();
      const t = resolveHttpTarget();
      if ('error' in t) { console.error(chalk.red(t.error)); process.exitCode = 1; return; }
      switch (act) {
        case 'login': case 'connect': await githubLogin(t); break;
        case 'logout': case 'disconnect': await githubLogout(t); break;
        case 'status': await githubStatus(t); break;
        default:
          console.error(chalk.red(`Unknown action "${action}". Use one of: login | logout | status`));
          process.exitCode = 1;
      }
    });
}
