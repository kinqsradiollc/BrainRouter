import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { RuntimeManager } from './manager.js';
import { readRuntimeRecord } from './state/runtimeStateStore.js';
import type { RuntimeBackendKind } from '../config/configTypes.js';

export const RUNTIME_API_PREFIX = '/runtime/v1';
export const RUNTIME_SESSION_HEADER = 'x-brainrouter-runtime-key';
export const RUNTIME_MAX_BODY_BYTES = 1024 * 1024;

export interface RuntimeServerOptions {
  enabled: boolean;
  manager: RuntimeManager;
  workspaceRoot: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
}

export interface RuntimeServerHandle {
  server: http.Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

interface StartRequest {
  sessionKey?: string;
  kind?: RuntimeBackendKind;
  launchCwd?: string;
  role?: string;
  model?: string;
  env?: Record<string, string>;
}

interface SendRequest {
  runtimeId?: string;
  prompt?: string;
  hidden?: boolean;
}

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '').trim() : (value ?? '').trim();
}

function readBody(req: http.IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        req.removeListener('data', onData);
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: http.IncomingMessage, cap: number): Promise<unknown> {
  const raw = await readBody(req, cap);
  if (raw === null) throw Object.assign(new Error('payload_too_large'), { status: 413 });
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireSessionHeader(req: http.IncomingMessage): string {
  return firstHeader(req.headers[RUNTIME_SESSION_HEADER]);
}

function assertStartAuthorized(req: http.IncomingMessage, sessionKey: string): void {
  if (!sessionKey || requireSessionHeader(req) !== sessionKey) {
    throw Object.assign(new Error('unauthorized'), { status: 401 });
  }
}

function assertRuntimeAuthorized(req: http.IncomingMessage, workspaceRoot: string, runtimeId: string): void {
  const record = readRuntimeRecord(workspaceRoot, runtimeId);
  if (!record || !record.sessionKey || requireSessionHeader(req) !== record.sessionKey) {
    throw Object.assign(new Error('unauthorized'), { status: 401 });
  }
}

function resolveInside(root: string, rel: string): string {
  const target = path.resolve(root, rel || '.');
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('path_outside_workspace'), { status: 403 });
  }
  return target;
}

function routeName(url: string | undefined): string {
  const pathname = (url ?? '').split('?')[0];
  if (!pathname.startsWith(`${RUNTIME_API_PREFIX}/`)) return '';
  return pathname.slice(RUNTIME_API_PREFIX.length + 1).replace(/\/+$/, '');
}

function queryParam(url: string | undefined, name: string): string {
  const reqUrl = new URL(url ?? '/', 'http://runtime.local');
  return reqUrl.searchParams.get(name)?.trim() ?? '';
}

function gitStatus(workspaceRoot: string): { ok: boolean; output: string } {
  const res = spawnSync('git', ['status', '--short'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: res.status === 0, output: res.status === 0 ? res.stdout : res.stderr };
}

export function createRuntimeRequestHandler(options: RuntimeServerOptions): http.RequestListener {
  const maxBody = options.maxBodyBytes ?? RUNTIME_MAX_BODY_BYTES;
  return (req, res) => {
    void (async () => {
      const route = routeName(req.url);
      if (!route) return sendJson(res, 404, { error: 'not_found' });
      if (req.method !== 'POST' && !(req.method === 'GET' && (route === 'status' || route === 'events' || route === 'file' || route === 'git'))) {
        return sendJson(res, 405, { error: 'method_not_allowed' });
      }

      if (route === 'start') {
        const body = asObject(await readJson(req, maxBody)) as StartRequest;
        const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '';
        assertStartAuthorized(req, sessionKey);
        const rt = await options.manager.start({
          sessionKey,
          kind: body.kind,
          launchCwd: body.launchCwd,
          role: body.role,
          model: body.model,
          env: body.env,
        });
        return sendJson(res, 200, { runtimeId: rt.id, status: rt.status(), kind: rt.kind });
      }

      const postBody = req.method === 'GET' ? {} : asObject(await readJson(req, maxBody));
      const runtimeId = (req.method === 'GET' ? queryParam(req.url, 'runtimeId') : String(postBody.runtimeId ?? '')).trim();
      if (!runtimeId) return sendJson(res, 400, { error: 'runtime_id_required' });
      assertRuntimeAuthorized(req, options.workspaceRoot, runtimeId);

      if (route === 'send') {
        const body = postBody as SendRequest;
        const prompt = typeof body.prompt === 'string' ? body.prompt : '';
        if (!prompt) return sendJson(res, 400, { error: 'prompt_required' });
        const result = await options.manager.exec(runtimeId, { prompt, hidden: body.hidden === true });
        return sendJson(res, 200, { runtimeId, output: result.output });
      }

      if (route === 'status') {
        const runtime = options.manager.get(runtimeId);
        const record = readRuntimeRecord(options.workspaceRoot, runtimeId);
        return sendJson(res, 200, { runtimeId, status: runtime?.status() ?? record?.status ?? 'unknown', live: !!runtime });
      }

      if (route === 'events') {
        return sendJson(res, 200, { runtimeId, events: [] });
      }

      if (route === 'file') {
        const rel = req.method === 'GET' ? queryParam(req.url, 'path') : String(postBody.path ?? '');
        const abs = resolveInside(options.workspaceRoot, rel);
        if (req.method === 'GET') {
          try {
            return sendJson(res, 200, { runtimeId, path: rel, content: fs.readFileSync(abs, 'utf8') });
          } catch {
            return sendJson(res, 404, { error: 'file_not_found' });
          }
        }
        const content = typeof postBody.content === 'string' ? postBody.content : '';
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        return sendJson(res, 200, { runtimeId, path: rel, written: true });
      }

      if (route === 'git') {
        return sendJson(res, 200, { runtimeId, status: gitStatus(options.workspaceRoot) });
      }

      return sendJson(res, 404, { error: 'not_found' });
    })().catch((error) => {
      const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 500;
      if (!res.headersSent) sendJson(res, status, { error: error instanceof Error ? error.message : 'internal' });
    });
  };
}

export function startRuntimeServer(options: RuntimeServerOptions): Promise<RuntimeServerHandle> {
  if (options.enabled !== true) {
    return Promise.reject(new Error('Runtime runner server is disabled. Set cli.runtime.serve to true to opt in.'));
  }
  const host = (options.host ?? '').trim() || '127.0.0.1';
  const port = Number.isInteger(options.port) ? (options.port as number) : 8791;
  const server = http.createServer(createRuntimeRequestHandler(options));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        host,
        port: boundPort,
        close: () => new Promise<void>((done, fail) => {
          server.close((err) => (err ? fail(err) : done()));
        }),
      });
    });
  });
}
