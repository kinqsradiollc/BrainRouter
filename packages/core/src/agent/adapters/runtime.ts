import { getAgentAdapter } from './catalog.js';
import type { AdapterLaunchPlan, AgentAdapterId, HostedAgentHookEvent, HostedAgentStatus } from './types.js';

export function buildAdapterLaunchPlan(input: {
  adapterId: AgentAdapterId;
  executable?: string;
  prompt?: string;
  resumeSessionId?: string;
  trusted?: boolean;
  sessionKey: string;
}): AdapterLaunchPlan {
  const adapter = getAgentAdapter(input.adapterId)!;
  if (!input.executable) return { ok: false, adapter, status: 'failed', error: 'not-installed' };
  if (adapter.requiresWorkspaceTrust && !input.trusted) {
    return { ok: false, adapter, status: 'needs-trust', error: 'trust-required' };
  }
  return {
    ok: true,
    adapter,
    executable: input.executable,
    args: input.resumeSessionId ? adapter.resumeArgs(input.resumeSessionId) : [...adapter.interactiveArgs],
    initialInput: input.prompt?.trim() ? `${input.prompt.trim()}\r` : undefined,
    reuseKey: `hosted-agent:${input.sessionKey}`,
    status: 'starting',
  };
}

export function statusFromTerminalOutput(
  output: string,
  current: HostedAgentStatus = 'working',
  adapterId: AgentAdapterId = 'brainrouter',
): HostedAgentStatus {
  if (!output) return current;
  const patterns = getAgentAdapter(adapterId)?.statusPatterns ?? {};
  for (const status of ['failed', 'blocked', 'done', 'waiting'] as const) {
    if ((patterns[status] ?? []).some((pattern) => pattern.test(output))) return status;
  }
  return 'working';
}

export function normalizeHostedAgentHook(event: HostedAgentHookEvent): HostedAgentStatus {
  const name = event.event.toLowerCase();
  if ((event.exitCode ?? 0) !== 0 || /error|fail/.test(name)) return 'failed';
  if (/approval|permission|needs.input|notification/.test(name)) return 'blocked';
  if (/stop|complete|idle|afteragent|sessionend/.test(name)) return 'done';
  if (/prompt|waiting/.test(name)) return 'waiting';
  return 'working';
}
