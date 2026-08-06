import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { RuntimeBackendKind } from '../config/configTypes.js';
import { RuntimeManager } from './manager.js';
import type { RuntimeStatus, RuntimeTurnExecutor } from './runtimeTypes.js';
import { assertRuntimeServerCompatible, type RuntimeFetch } from './client.js';
import { RUNTIME_SESSION_HEADER } from './server.js';
import { stripTrailingSlashes } from '../util/trimEdges.js';

export interface RuntimeRunnerStartInput {
  sessionKey: string;
  runtimeId?: string;
  kind?: RuntimeBackendKind;
  launchCwd?: string;
  role?: string;
  model?: string;
  env?: Record<string, string>;
}

export interface RuntimeRunnerSendInput {
  runtimeId: string;
  sessionKey: string;
  prompt: string;
  hidden?: boolean;
}

export interface RuntimeRunnerRuntimeInput {
  runtimeId: string;
  sessionKey: string;
}

export interface RuntimeRunnerFileInput extends RuntimeRunnerRuntimeInput {
  path: string;
}

export interface RuntimeRunnerWriteFileInput extends RuntimeRunnerFileInput {
  content: string;
}

export interface RuntimeRunnerStartResult {
  runtimeId: string;
  status: RuntimeStatus;
  kind: RuntimeBackendKind;
}

export interface RuntimeRunnerSendResult {
  runtimeId: string;
  output?: string;
  queued?: boolean;
  pending?: number;
}

export interface RuntimeRunnerStatusResult {
  runtimeId: string;
  status: RuntimeStatus | 'unknown';
  live: boolean;
}

export interface RuntimeRunnerEventsResult {
  runtimeId: string;
  events: unknown[];
}

export interface RuntimeRunnerReadFileResult {
  runtimeId: string;
  path: string;
  content: string;
}

export interface RuntimeRunnerWriteFileResult {
  runtimeId: string;
  path: string;
  written: boolean;
}

export interface RuntimeRunnerGitStatusResult {
  runtimeId: string;
  status: { ok: boolean; output: string };
}

export interface RuntimeRunnerClient {
  mode: 'in-process' | 'remote';
  start(input: RuntimeRunnerStartInput): Promise<RuntimeRunnerStartResult>;
  send(input: RuntimeRunnerSendInput): Promise<RuntimeRunnerSendResult>;
  status(input: RuntimeRunnerRuntimeInput): Promise<RuntimeRunnerStatusResult>;
  events(input: RuntimeRunnerRuntimeInput): Promise<RuntimeRunnerEventsResult>;
  readFile(input: RuntimeRunnerFileInput): Promise<RuntimeRunnerReadFileResult>;
  writeFile(input: RuntimeRunnerWriteFileInput): Promise<RuntimeRunnerWriteFileResult>;
  gitStatus(input: RuntimeRunnerRuntimeInput): Promise<RuntimeRunnerGitStatusResult>;
}

export interface CreateRuntimeRunnerClientOptions {
  workspaceRoot: string;
  executeTurn: RuntimeTurnExecutor;
  remoteUrl?: string;
  fetch?: RuntimeFetch;
  manager?: RuntimeManager;
  maxLive?: number;
  maxPendingMessages?: number;
}

function trimBaseUrl(baseUrl: string): string {
  return stripTrailingSlashes(baseUrl.trim());
}

function resolveInside(root: string, rel: string): string {
  const target = path.resolve(root, rel || '.');
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('path_outside_workspace');
  }
  return target;
}

function gitStatus(workspaceRoot: string): { ok: boolean; output: string } {
  const res = spawnSync('git', ['status', '--short'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: res.status === 0, output: res.status === 0 ? res.stdout : res.stderr };
}

function getFetch(fetchImpl?: RuntimeFetch): RuntimeFetch {
  const fn = fetchImpl ?? globalThis.fetch;
  if (!fn) throw new Error('No fetch implementation is available for runtime client requests');
  return fn.bind(globalThis) as RuntimeFetch;
}

function jsonHeaders(sessionKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    [RUNTIME_SESSION_HEADER]: sessionKey,
  };
}

async function readJsonResponse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${res.status}`;
    throw new Error(error);
  }
  return body as T;
}

class InProcessRuntimeRunnerClient implements RuntimeRunnerClient {
  readonly mode = 'in-process' as const;

  constructor(
    private readonly workspaceRoot: string,
    private readonly manager: RuntimeManager,
  ) {}

  async start(input: RuntimeRunnerStartInput): Promise<RuntimeRunnerStartResult> {
    const runtime = await this.manager.start(input);
    return { runtimeId: runtime.id, status: runtime.status(), kind: runtime.kind };
  }

  async send(input: RuntimeRunnerSendInput): Promise<RuntimeRunnerSendResult> {
    const runtime = this.manager.get(input.runtimeId);
    if (runtime?.status() === 'starting') {
      const queued = this.manager.queueTurn(input.runtimeId, { prompt: input.prompt, hidden: input.hidden === true });
      if (!queued.accepted) throw new Error('pending_queue_full');
      return { runtimeId: input.runtimeId, queued: true, pending: queued.queued };
    }
    const result = await this.manager.exec(input.runtimeId, { prompt: input.prompt, hidden: input.hidden === true });
    return { runtimeId: input.runtimeId, output: result.output };
  }

  async status(input: RuntimeRunnerRuntimeInput): Promise<RuntimeRunnerStatusResult> {
    const runtime = this.manager.get(input.runtimeId);
    return { runtimeId: input.runtimeId, status: runtime?.status() ?? 'unknown', live: !!runtime };
  }

  async events(input: RuntimeRunnerRuntimeInput): Promise<RuntimeRunnerEventsResult> {
    return { runtimeId: input.runtimeId, events: [] };
  }

  async readFile(input: RuntimeRunnerFileInput): Promise<RuntimeRunnerReadFileResult> {
    const abs = resolveInside(this.workspaceRoot, input.path);
    return { runtimeId: input.runtimeId, path: input.path, content: fs.readFileSync(abs, 'utf8') };
  }

  async writeFile(input: RuntimeRunnerWriteFileInput): Promise<RuntimeRunnerWriteFileResult> {
    const abs = resolveInside(this.workspaceRoot, input.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, input.content, 'utf8');
    return { runtimeId: input.runtimeId, path: input.path, written: true };
  }

  async gitStatus(input: RuntimeRunnerRuntimeInput): Promise<RuntimeRunnerGitStatusResult> {
    return { runtimeId: input.runtimeId, status: gitStatus(this.workspaceRoot) };
  }
}

class RemoteRuntimeRunnerClient implements RuntimeRunnerClient {
  readonly mode = 'remote' as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: RuntimeFetch;
  private compatible: Promise<unknown> | null = null;

  constructor(baseUrl: string, fetchImpl?: RuntimeFetch) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.fetchImpl = getFetch(fetchImpl);
  }

  private async ensureCompatible(): Promise<void> {
    this.compatible ??= assertRuntimeServerCompatible(this.baseUrl, { fetch: this.fetchImpl });
    await this.compatible;
  }

  private async get<T>(pathName: string, sessionKey: string, params: Record<string, string>): Promise<T> {
    await this.ensureCompatible();
    const url = new URL(`${this.baseUrl}/runtime/v1/${pathName}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const res = await this.fetchImpl(url, { headers: { [RUNTIME_SESSION_HEADER]: sessionKey } });
    return readJsonResponse<T>(res);
  }

  private async post<T>(pathName: string, sessionKey: string, body: Record<string, unknown>): Promise<T> {
    await this.ensureCompatible();
    const res = await this.fetchImpl(`${this.baseUrl}/runtime/v1/${pathName}`, {
      method: 'POST',
      headers: jsonHeaders(sessionKey),
      body: JSON.stringify(body),
    });
    return readJsonResponse<T>(res);
  }

  start(input: RuntimeRunnerStartInput): Promise<RuntimeRunnerStartResult> {
    return this.post<RuntimeRunnerStartResult>('start', input.sessionKey, input as unknown as Record<string, unknown>);
  }

  send(input: RuntimeRunnerSendInput): Promise<RuntimeRunnerSendResult> {
    return this.post<RuntimeRunnerSendResult>('send', input.sessionKey, {
      runtimeId: input.runtimeId,
      prompt: input.prompt,
      hidden: input.hidden === true,
    });
  }

  status(input: RuntimeRunnerRuntimeInput): Promise<RuntimeRunnerStatusResult> {
    return this.get<RuntimeRunnerStatusResult>('status', input.sessionKey, { runtimeId: input.runtimeId });
  }

  events(input: RuntimeRunnerRuntimeInput): Promise<RuntimeRunnerEventsResult> {
    return this.get<RuntimeRunnerEventsResult>('events', input.sessionKey, { runtimeId: input.runtimeId });
  }

  readFile(input: RuntimeRunnerFileInput): Promise<RuntimeRunnerReadFileResult> {
    return this.get<RuntimeRunnerReadFileResult>('file', input.sessionKey, { runtimeId: input.runtimeId, path: input.path });
  }

  writeFile(input: RuntimeRunnerWriteFileInput): Promise<RuntimeRunnerWriteFileResult> {
    return this.post<RuntimeRunnerWriteFileResult>('file', input.sessionKey, {
      runtimeId: input.runtimeId,
      path: input.path,
      content: input.content,
    });
  }

  gitStatus(input: RuntimeRunnerRuntimeInput): Promise<RuntimeRunnerGitStatusResult> {
    return this.get<RuntimeRunnerGitStatusResult>('git', input.sessionKey, { runtimeId: input.runtimeId });
  }
}

export function createRuntimeRunnerClient(options: CreateRuntimeRunnerClientOptions): RuntimeRunnerClient {
  const remoteUrl = options.remoteUrl?.trim();
  if (remoteUrl) return new RemoteRuntimeRunnerClient(remoteUrl, options.fetch);
  const manager = options.manager ?? new RuntimeManager({
    workspaceRoot: options.workspaceRoot,
    executeTurn: options.executeTurn,
    maxLive: options.maxLive,
    maxPendingMessages: options.maxPendingMessages,
  });
  return new InProcessRuntimeRunnerClient(options.workspaceRoot, manager);
}
