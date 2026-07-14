import type { AgentAdapter, AgentAdapterId } from './types.js';
import { getAgentAdapter } from './catalog.js';
import fs from 'node:fs';
import path from 'node:path';

export interface AdapterIntegrationPlan {
  adapterId: AgentAdapterId;
  hookSink: { command: string; args: string[]; events: string[] };
  mcp?: { command: string; args: string[] };
}

/**
 * Returns explicit, inspectable install steps. Callers must execute these only
 * after a user chooses Setup; no provider credential is included or persisted.
 */
export function createAdapterIntegrationPlan(adapterId: AgentAdapterId): AdapterIntegrationPlan {
  const adapter = getAgentAdapter(adapterId) as AgentAdapter;
  return {
    adapterId,
    hookSink: {
      command: 'brainrouter',
      args: ['agent-hook', '--adapter', adapterId, '--event', '$EVENT'],
      events: [...adapter.integration.hookEvents],
    },
    ...(adapter.integration.mcp ? { mcp: { ...adapter.integration.mcp, args: [...adapter.integration.mcp.args] } } : {}),
  };
}

export function installNativeAgentHooks(workspaceRoot: string, adapterId: AgentAdapterId): { installed: boolean; path?: string; mode: 'native' | 'builtin' | 'terminal' } {
  if (adapterId === 'brainrouter') return { installed: true, mode: 'builtin' };
  const target = adapterId === 'claude-code'
    ? path.join(workspaceRoot, '.claude', 'settings.local.json')
    : adapterId === 'gemini-cli'
      ? path.join(workspaceRoot, '.gemini', 'settings.json')
      : undefined;
  if (!target) return { installed: false, mode: 'terminal' };

  const adapter = getAgentAdapter(adapterId)!;
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>; } catch { /* new or invalid file */ }
  const existingHooks = current.hooks && typeof current.hooks === 'object'
    ? current.hooks as Record<string, unknown>
    : {};
  const managed = Object.fromEntries(adapter.integration.hookEvents.map((event) => [event, [{
    hooks: [{
      type: 'command',
      command: `brainrouter agent-hook --adapter ${adapterId} --event ${event}`,
    }],
  }]]));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ ...current, hooks: { ...existingHooks, ...managed } }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* Windows */ }
  return { installed: true, path: target, mode: 'native' };
}

export function installStaticMcpConfig(workspaceRoot: string, adapterId: AgentAdapterId): { installed: boolean; path?: string } {
  if (adapterId !== 'opencode') return { installed: false };
  const target = path.join(workspaceRoot, 'opencode.json');
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>; } catch { /* new file */ }
  const mcp = current.mcp && typeof current.mcp === 'object' ? current.mcp as Record<string, unknown> : {};
  const next = {
    ...current,
    mcp: {
      ...mcp,
      brainrouter: { type: 'local', command: ['brainrouter', 'mcp-proxy'], enabled: true },
    },
  };
  fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* Windows */ }
  return { installed: true, path: target };
}
