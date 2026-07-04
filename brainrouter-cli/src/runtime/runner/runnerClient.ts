import {
  createRuntimeRunnerClient,
  type RuntimeFetch,
  type RuntimeRunnerClient,
} from '@kinqs/brainrouter-core/runtime';
import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import type { RuntimeTurnExecutor } from '@kinqs/brainrouter-core/runtime';

export interface CliRuntimeRunnerClientOptions {
  workspaceRoot: string;
  executeTurn: RuntimeTurnExecutor;
  fetch?: RuntimeFetch;
  remoteUrl?: string;
}

export interface CliRuntimeRunnerSummary {
  mode: RuntimeRunnerClient['mode'];
  remoteUrl: string | null;
}

export function createCliRuntimeRunnerClient(options: CliRuntimeRunnerClientOptions): RuntimeRunnerClient {
  const remoteUrl = options.remoteUrl ?? getCliKnobs().runtime.remoteUrl;
  return createRuntimeRunnerClient({
    workspaceRoot: options.workspaceRoot,
    executeTurn: options.executeTurn,
    remoteUrl,
    fetch: options.fetch,
  });
}

export function summarizeCliRuntimeRunner(client: RuntimeRunnerClient, remoteUrl: string): CliRuntimeRunnerSummary {
  return { mode: client.mode, remoteUrl: remoteUrl.trim() || null };
}

export function formatCliRuntimeRunnerSummary(summary: CliRuntimeRunnerSummary): string {
  const lines = [`Runner mode: ${summary.mode}`];
  if (summary.remoteUrl) lines.push(`Remote URL: ${summary.remoteUrl}`);
  return `${lines.join('\n')}\n`;
}
