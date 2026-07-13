import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { loadConfig, type Config } from '@kinqs/brainrouter-core/config';

export function resolveMcpProxyEnv(config: Config, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const active = config.activeServer ? config.servers?.[config.activeServer] : undefined;
  const apiKey = active?.apiKey?.trim() || env.BRAINROUTER_API_KEY?.trim();
  return { ...env, ...(apiKey ? { BRAINROUTER_API_KEY: apiKey } : {}) };
}

export function registerMcpProxyCommand(program: Command): void {
  program.command('mcp-proxy')
    .description('Run the local BrainRouter MCP using the sealed active-profile credential.')
    .action(async () => {
      const env = resolveMcpProxyEnv(loadConfig());
      await new Promise<void>((resolve, reject) => {
        const child = spawn('brainrouter-mcp', [], { cwd: process.cwd(), env, stdio: 'inherit' });
        let stopping = false;
        const stop = (signal: NodeJS.Signals): void => {
          stopping = true;
          try { child.kill(signal); } catch { /* already stopped */ }
        };
        const onSigterm = (): void => stop('SIGTERM');
        const onSigint = (): void => stop('SIGINT');
        process.once('SIGTERM', onSigterm);
        process.once('SIGINT', onSigint);
        const cleanup = (): void => {
          process.off('SIGTERM', onSigterm);
          process.off('SIGINT', onSigint);
        };
        child.once('error', (error) => { cleanup(); reject(error); });
        child.once('exit', (code, signal) => {
          cleanup();
          if (stopping) resolve();
          else if (signal) reject(new Error(`brainrouter-mcp exited via ${signal}`));
          else if ((code ?? 0) !== 0) reject(new Error(`brainrouter-mcp exited ${code}`));
          else resolve();
        });
      });
    });
}
