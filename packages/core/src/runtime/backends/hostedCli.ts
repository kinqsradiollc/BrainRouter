import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getCliKnobs } from '../../config/config.js';
import type { ResolvedHostedAgentConfig } from '../../config/configTypes.js';
import type {
  IAgentRuntime,
  RuntimeSpec,
  RuntimeStatus,
  RuntimeTurn,
  RuntimeTurnResult,
} from '../runtimeTypes.js';
import {
  createRuntimeRecord,
  newRuntimeInstanceId,
  updateRuntimeRecord,
} from '../state/runtimeStateStore.js';

interface PendingTurn {
  resolve: (value: RuntimeTurnResult) => void;
  reject: (error: Error) => void;
}

export interface HostedCliRuntimeOptions {
  name?: string;
  id?: string;
  now?: () => string;
  config?: ResolvedHostedAgentConfig;
  spawnProcess?: typeof spawn;
}

export class HostedCliAgentRuntime implements IAgentRuntime {
  public readonly id: string;
  public readonly kind = 'hosted' as const;

  private readonly name?: string;
  private readonly nowFn: () => string;
  private readonly configOverride?: ResolvedHostedAgentConfig;
  private readonly spawnProcess: typeof spawn;
  private state: RuntimeStatus = 'starting';
  private spec: RuntimeSpec | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private pending: PendingTurn[] = [];

  constructor(options: HostedCliRuntimeOptions = {}) {
    this.name = options.name;
    this.id = options.id ?? newRuntimeInstanceId();
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.configOverride = options.config;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  status(): RuntimeStatus {
    return this.state;
  }

  async start(spec: RuntimeSpec): Promise<void> {
    if (this.spec) throw new Error(`runtime ${this.id} already started`);
    this.spec = spec;
    createRuntimeRecord(spec.workspaceRoot, {
      id: this.id,
      backend: this.kind,
      sessionKey: spec.sessionKey,
      status: 'starting',
      now: this.nowFn(),
    });
    const config = this.resolveConfig(spec);
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnProcess(config.command, config.args, {
        cwd: spec.launchCwd || spec.workspaceRoot,
        env: { ...process.env, ...(spec.env ?? {}), BRAINROUTER_RUNTIME_SESSION_KEY: spec.sessionKey },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      const onError = (error: Error) => {
        this.setState('error');
        reject(error);
      };
      child.once('error', onError);
      child.once('spawn', () => {
        child.off('error', onError);
        this.attachOutput(child, config);
        child.once('exit', () => {
          if (this.state !== 'disposed') this.setState('error');
          this.rejectPending(new Error(`hosted agent '${config.name}' exited`));
        });
        this.setState('ready');
        resolve();
      });
    });
  }

  async exec(turn: RuntimeTurn): Promise<RuntimeTurnResult> {
    const spec = this.requireStarted();
    const child = this.child;
    if (!child || this.state !== 'ready') {
      throw new Error(`runtime ${this.id} cannot exec while '${this.state}' (expected 'ready')`);
    }
    const config = this.resolveConfig(spec);
    this.setState('running');
    return new Promise<RuntimeTurnResult>((resolve, reject) => {
      this.pending.push({
        resolve: (result) => {
          this.setState('ready');
          resolve(result);
        },
        reject: (error) => {
          this.setState('error');
          reject(error);
        },
      });
      const payload = config.protocol === 'stdio'
        ? `${turn.prompt}\n`
        : `${JSON.stringify({ prompt: turn.prompt, hidden: turn.hidden === true })}\n`;
      child.stdin.write(payload, (error) => {
        if (error) this.failNext(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async pause(): Promise<void> {
    if (this.state !== 'ready') throw new Error(`runtime ${this.id} cannot pause while '${this.state}' (expected 'ready')`);
    this.setState('paused');
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') throw new Error(`runtime ${this.id} cannot resume while '${this.state}' (expected 'paused')`);
    this.setState('ready');
  }

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    this.child?.kill('SIGTERM');
    this.child = null;
    this.rejectPending(new Error(`runtime ${this.id} disposed`));
    this.setState('disposed');
  }

  private resolveConfig(spec: RuntimeSpec): ResolvedHostedAgentConfig {
    if (this.configOverride) return this.configOverride;
    const target = this.name ?? spec.role ?? '';
    const match = getCliKnobs().agents.hosted.find((agent) => agent.name === target);
    if (!match) throw new Error(`hosted agent '${target || '(unset)'}' is not configured`);
    return match;
  }

  private attachOutput(child: ChildProcessWithoutNullStreams, config: ResolvedHostedAgentConfig): void {
    child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8');
      let newline = this.stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.stdoutBuffer.slice(0, newline).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (line) this.resolveLine(line, config);
        newline = this.stdoutBuffer.indexOf('\n');
      }
    });
  }

  private resolveLine(line: string, config: ResolvedHostedAgentConfig): void {
    const pending = this.pending.shift();
    if (!pending) return;
    if (config.protocol === 'stdio') {
      pending.resolve({ output: line });
      return;
    }
    try {
      const parsed = JSON.parse(line) as { output?: unknown; error?: unknown };
      if (typeof parsed.error === 'string') pending.reject(new Error(parsed.error));
      else pending.resolve({ output: typeof parsed.output === 'string' ? parsed.output : line });
    } catch {
      pending.resolve({ output: line });
    }
  }

  private failNext(error: Error): void {
    const pending = this.pending.shift();
    if (pending) pending.reject(error);
  }

  private rejectPending(error: Error): void {
    const pending = this.pending.splice(0);
    for (const item of pending) item.reject(error);
  }

  private requireStarted(): RuntimeSpec {
    if (!this.spec) throw new Error(`runtime ${this.id} not started`);
    return this.spec;
  }

  private setState(next: RuntimeStatus): void {
    this.state = next;
    if (this.spec) updateRuntimeRecord(this.spec.workspaceRoot, this.id, { status: next }, this.nowFn());
  }
}

export function createHostedCliRuntime(options: HostedCliRuntimeOptions = {}): HostedCliAgentRuntime {
  return new HostedCliAgentRuntime(options);
}
