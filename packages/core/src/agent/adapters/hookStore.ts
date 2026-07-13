import fs from 'node:fs';
import path from 'node:path';
import { getStateFile } from '../../storage/store.js';
import type { HostedAgentHookEvent } from './types.js';

export interface StoredHostedAgentHook extends HostedAgentHookEvent {
  at: string;
}

function hookFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'hostedAgentHooks.jsonl');
}

export function recordHostedAgentHook(workspaceRoot: string, event: HostedAgentHookEvent): StoredHostedAgentHook {
  const record = { ...event, at: new Date().toISOString() };
  const file = hookFile(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
  return record;
}

export function readHostedAgentHooks(workspaceRoot: string, limit = 200): StoredHostedAgentHook[] {
  try {
    return fs.readFileSync(hookFile(workspaceRoot), 'utf8')
      .split('\n').filter(Boolean).slice(-Math.max(1, limit))
      .flatMap((line) => {
        try { return [JSON.parse(line) as StoredHostedAgentHook]; } catch { return []; }
      });
  } catch { return []; }
}
