/**
 * ADR-050 P2 — a JSON-RPC 2.0 peer over newline-delimited stdio, on top of
 * {@link LineStdioProcess}. The shared substrate for the two JSON-RPC transports
 * (Codex `app-server` and ACP): correlated `request`/response, `notify`, and —
 * crucially — inbound requests FROM the peer (ACP's `session/request_permission`
 * is a request the CLIENT answers), dispatched to a handler that returns the
 * result. Pending requests reject on process exit so a turn never hangs.
 */
import { LineStdioProcess } from './lineStdioProcess.js';
import type { AgentSessionDeps } from './types.js';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcHandlers {
  /** A one-way notification from the peer (no id). */
  onNotification?: (method: string, params: unknown) => void;
  /** A request FROM the peer expecting a response; return the result (or throw to error it). */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  onExit?: (code: number | null) => void;
  onError?: (err: Error) => void;
  onStderr?: (text: string) => void;
}

export class JsonRpcStdio {
  private proc?: LineStdioProcess;
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly handlers: JsonRpcHandlers,
    private readonly opts: { cwd?: string; env?: Record<string, string> } = {},
    private readonly deps: AgentSessionDeps = {},
  ) {}

  get running(): boolean { return !!this.proc?.running; }

  start(): void {
    if (this.proc?.running) return;
    this.proc = new LineStdioProcess(
      this.command, this.args,
      {
        onLine: (line) => this.onLine(line),
        ...(this.handlers.onStderr ? { onStderr: this.handlers.onStderr } : {}),
        onExit: (code) => { this.failAll(new Error(`process exited (${code ?? 'null'})`)); this.handlers.onExit?.(code); },
        onError: (err) => { this.failAll(err); this.handlers.onError?.(err); },
      },
      this.opts, this.deps,
    );
    this.proc.start();
  }

  private onLine(line: string): void {
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(line) as JsonRpcMessage; } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && (msg.result !== undefined || msg.error !== undefined)) {
      // A response to one of our requests.
      const entry = this.pending.get(msg.id as number | string);
      if (!entry) return;
      this.pending.delete(msg.id as number | string);
      if (msg.error) entry.reject(new Error(msg.error.message)); else entry.resolve(msg.result);
    } else if (hasId && typeof msg.method === 'string') {
      // A request FROM the peer — answer it via onRequest.
      const id = msg.id as number | string;
      Promise.resolve(this.handlers.onRequest?.(msg.method, msg.params))
        .then((result) => this.send({ jsonrpc: '2.0', id, result: result ?? null }))
        .catch((err) => this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }));
    } else if (typeof msg.method === 'string') {
      // A notification.
      this.handlers.onNotification?.(msg.method, msg.params);
    }
  }

  /** Send a request and resolve with its result (rejects on error/exit). */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    return promise;
  }

  /** Send a one-way notification. */
  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  private send(msg: object): void {
    this.proc?.write(JSON.stringify(msg));
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }

  kill(): void { this.proc?.kill(); }
}
