import { execFileSync } from 'node:child_process';
import {
  AGENT_ADAPTERS,
  buildAdapterLaunchPlan,
  createAdapterIntegrationPlan,
  detectAgentAdapters,
  getAgentAdapter,
  installNativeAgentHooks,
  installStaticMcpConfig,
  isAgentAdapterId,
  normalizeHostedAgentHook,
  readHostedAgentHooks,
  statusFromTerminalOutput,
  type AgentAdapterId,
  type HostedAgentStatus,
} from '@kinqs/brainrouter-core/agent';
import type { PtyOpenResult, PtyRegistry } from './pty.js';
import type { SshHostConfig, SshTransport } from './sshRemote.js';

export interface HostedAgentSession {
  instanceKey: string;
  sessionKey: string;
  adapterId: AgentAdapterId;
  terminalId: string;
  status: HostedAgentStatus;
  cursor: number;
  updatedAt: string;
}

export class HostedAgentManager {
  private readonly sessions = new Map<string, HostedAgentSession>();
  private readonly hookCursors = new Map<string, number>();

  constructor(private readonly options: {
    workspaceRoot: string;
    ptyRegistry: PtyRegistry;
    onTransition?: (session: HostedAgentSession, previous: HostedAgentStatus) => void;
  }) {}

  catalog() {
    const detected = new Map(detectAgentAdapters().map((row) => [row.id, row]));
    return AGENT_ADAPTERS.map((adapter) => ({
      id: adapter.id, label: adapter.label, requiresWorkspaceTrust: adapter.requiresWorkspaceTrust,
      installed: detected.get(adapter.id)?.installed ?? false,
      executable: detected.get(adapter.id)?.executable,
    }));
  }

  start(input: {
    sessionKey: string;
    adapterId: string;
    prompt?: string;
    resumeSessionId?: string;
    trusted?: boolean;
    cols?: number;
    rows?: number;
    instanceKey?: string;
    cwd?: string;
  }): (PtyOpenResult & { adapterId: AgentAdapterId; status: HostedAgentStatus }) | { error: string; status: HostedAgentStatus } {
    if (!isAgentAdapterId(input.adapterId)) return { error: 'unknown-adapter', status: 'failed' };
    const instanceKey = input.instanceKey ?? input.sessionKey;
    const prior = this.sessions.get(instanceKey);
    if (prior && prior.adapterId !== input.adapterId) {
      this.options.ptyRegistry.kill(prior.terminalId);
      this.sessions.delete(instanceKey);
    }
    const detection = detectAgentAdapters().find((row) => row.id === input.adapterId);
    const plan = buildAdapterLaunchPlan({
      adapterId: input.adapterId,
      executable: detection?.executable,
      prompt: input.prompt,
      resumeSessionId: input.resumeSessionId,
      trusted: input.trusted,
      sessionKey: instanceKey,
    });
    if (!plan.ok || !plan.executable || !plan.args) return { error: plan.error ?? 'launch-failed', status: plan.status };
    const opened = this.options.ptyRegistry.open({
      shell: plan.executable, args: plan.args, reuseKey: `hosted-agent:${instanceKey}`,
      cols: input.cols, rows: input.rows,
      cwd: input.cwd,
    });
    const session: HostedAgentSession = {
      instanceKey, sessionKey: input.sessionKey, adapterId: input.adapterId, terminalId: opened.id,
      status: 'working', cursor: opened.next, updatedAt: new Date().toISOString(),
    };
    const previous = this.sessions.get(instanceKey)?.status ?? 'idle';
    this.sessions.set(instanceKey, session);
    this.options.onTransition?.(session, previous);
    if (plan.initialInput && !opened.reused) {
      const initialInput = plan.initialInput;
      setTimeout(() => { this.options.ptyRegistry.write(opened.id, initialInput); }, 250);
    }
    return { ...opened, adapterId: input.adapterId, status: session.status };
  }

  async startRemote(input: {
    sessionKey: string;
    instanceKey: string;
    adapterId: string;
    host: SshHostConfig;
    transport: SshTransport;
    cwd: string;
    prompt?: string;
    resumeSessionId?: string;
    trusted?: boolean;
    cols?: number;
    rows?: number;
  }): Promise<(PtyOpenResult & { adapterId: AgentAdapterId; status: HostedAgentStatus }) | { error: string; status: HostedAgentStatus }> {
    if (!isAgentAdapterId(input.adapterId)) return { error: 'unknown-adapter', status: 'failed' };
    const adapter = getAgentAdapter(input.adapterId)!;
    const plan = buildAdapterLaunchPlan({
      adapterId: input.adapterId,
      executable: adapter.command,
      prompt: input.prompt,
      resumeSessionId: input.resumeSessionId,
      trusted: input.trusted,
      sessionKey: input.instanceKey,
    });
    if (!plan.ok || !plan.executable || !plan.args) return { error: plan.error ?? 'launch-failed', status: plan.status };
    try {
      const remotePty = await input.transport.openPty(
        input.host, plan.executable, plan.args, input.cwd,
        Math.max(2, Math.min(1_000, Math.floor(input.cols ?? 100))),
        Math.max(1, Math.min(1_000, Math.floor(input.rows ?? 30))),
      );
      const opened = this.options.ptyRegistry.adopt(remotePty, {
        shell: `ssh://${input.host.username}@${input.host.host}/${plan.executable}`,
        reuseKey: `hosted-agent:${input.instanceKey}`,
      });
      const session: HostedAgentSession = {
        instanceKey: input.instanceKey, sessionKey: input.sessionKey, adapterId: input.adapterId,
        terminalId: opened.id, status: 'working', cursor: opened.next, updatedAt: new Date().toISOString(),
      };
      const previous = this.sessions.get(input.instanceKey)?.status ?? 'idle';
      this.sessions.set(input.instanceKey, session);
      this.options.onTransition?.(session, previous);
      if (plan.initialInput && !opened.reused) {
        const initialInput = plan.initialInput;
        setTimeout(() => { this.options.ptyRegistry.write(opened.id, initialInput); }, 250);
      }
      return { ...opened, adapterId: input.adapterId, status: session.status };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), status: 'failed' };
    }
  }

  attach(sessionKey: string): (PtyOpenResult & { adapterId: AgentAdapterId; status: HostedAgentStatus }) | null {
    const session = this.refresh(sessionKey);
    if (!session) return null;
    const snapshot = this.options.ptyRegistry.snapshot(session.terminalId);
    return snapshot ? { ...snapshot, adapterId: session.adapterId, status: session.status } : null;
  }

  control(sessionKey: string, action: 'follow-up' | 'interrupt' | 'approve', text?: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (!session) return false;
    const adapter = getAgentAdapter(session.adapterId)!;
    const data = action === 'follow-up'
      ? `${text?.trim() ?? ''}${adapter.controls.submit}`
      : action === 'interrupt' ? adapter.controls.interrupt : adapter.controls.approve;
    const ok = this.options.ptyRegistry.write(session.terminalId, data);
    if (ok) this.transition(session, action === 'interrupt' ? 'waiting' : 'working');
    return ok;
  }

  writeRaw(instanceKey: string, data: string): boolean {
    const session = this.sessions.get(instanceKey);
    if (!session || Buffer.byteLength(data, 'utf8') > 8_192) return false;
    return this.options.ptyRegistry.write(session.terminalId, data);
  }

  refresh(sessionKey: string): HostedAgentSession | null {
    const session = this.sessions.get(sessionKey);
    if (!session) return null;
    const read = this.options.ptyRegistry.read(session.terminalId, session.cursor);
    session.cursor = read.next;
    let next = statusFromTerminalOutput(read.chunk, session.status, session.adapterId);
    if (!read.alive && !['failed', 'done'].includes(next)) next = 'done';
    const hooks = readHostedAgentHooks(this.options.workspaceRoot);
    const hookCursor = this.hookCursors.get(session.instanceKey) ?? 0;
    for (const hook of hooks.slice(hookCursor)) {
      if (hook.adapterId === session.adapterId && (!hook.sessionId || hook.sessionId === sessionKey)) {
        next = normalizeHostedAgentHook(hook);
      }
    }
    this.hookCursors.set(session.instanceKey, hooks.length);
    this.transition(session, next);
    return { ...session };
  }

  setup(adapterId: string): { ok: boolean; hookCommand?: string; mcp?: string; error?: string } {
    if (!isAgentAdapterId(adapterId)) return { ok: false, error: 'unknown-adapter' };
    const integration = createAdapterIntegrationPlan(adapterId);
    try {
      const hooks = installNativeAgentHooks(this.options.workspaceRoot, adapterId);
      const staticMcp = installStaticMcpConfig(this.options.workspaceRoot, adapterId);
      if (integration.mcp) execFileSync(integration.mcp.command, integration.mcp.args, {
        cwd: this.options.workspaceRoot, timeout: 20_000, stdio: 'pipe', env: process.env,
      });
      return {
        ok: true,
        hookCommand: hooks.installed
          ? `${hooks.mode}${hooks.path ? `:${hooks.path}` : ''}`
          : [integration.hookSink.command, ...integration.hookSink.args].join(' '),
        mcp: integration.mcp || staticMcp.installed ? 'registered' : 'built-in',
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  kill(instanceKey: string): boolean {
    const session = this.sessions.get(instanceKey);
    if (!session) return false;
    const killed = this.options.ptyRegistry.kill(session.terminalId);
    this.sessions.delete(instanceKey);
    this.hookCursors.delete(instanceKey);
    return killed;
  }

  dispose(): void {
    for (const instanceKey of [...this.sessions.keys()]) this.kill(instanceKey);
  }

  private transition(session: HostedAgentSession, next: HostedAgentStatus): void {
    if (session.status === next) return;
    const previous = session.status;
    session.status = next;
    session.updatedAt = new Date().toISOString();
    this.options.onTransition?.({ ...session }, previous);
  }
}
