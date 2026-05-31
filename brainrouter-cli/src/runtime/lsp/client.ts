import { spawn } from 'node:child_process';
import { encodeFrame, LspFrameParser } from './framing.js';

/**
 * CLI-19 (0.4.4) — a minimal but real LSP client. Speaks JSON-RPC over a
 * `LspTransport` (default: a spawned language-server process over stdio), does
 * the initialize handshake, opens documents, and answers definition /
 * references / hover / documentSymbol. The transport is injectable so the
 * client is testable against a mock server without installing one.
 */

export interface LspTransport {
  send(frame: string): void;
  onMessage(cb: (msg: any) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface LspPosition {
  line: number; // 0-based
  character: number; // 0-based
}

/** A spawned-process stdio transport. An 'error' handler is mandatory (a missing
 * server must not crash the CLI — ORCH-FIX class). Returns null if spawn throws. */
export function spawnStdioTransport(command: string, args: string[], cwd: string): LspTransport | null {
  let child;
  try {
    child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
  const parser = new LspFrameParser();
  let msgCb: (m: any) => void = () => {};
  let closeCb: () => void = () => {};
  child.stdout?.on('data', (d: Buffer) => { for (const m of parser.push(d)) msgCb(m); });
  child.stderr?.on('data', () => {}); // drain so the pipe never blocks
  child.on('error', () => closeCb());
  child.on('close', () => closeCb());
  return {
    send: (frame) => { try { child.stdin?.write(frame); } catch { /* server gone */ } },
    onMessage: (cb) => { msgCb = cb; },
    onClose: (cb) => { closeCb = cb; },
    close: () => { try { child.kill(); } catch { /* noop */ } },
  };
}

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private initialized = false;
  private opened = new Set<string>();
  private closed = false;
  private readonly timeoutMs: number;

  constructor(private transport: LspTransport, opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? 8000;
    transport.onMessage((msg) => this.onMessage(msg));
    transport.onClose(() => this.onClose());
  }

  private onMessage(msg: any): void {
    if (msg && typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error?.message ?? 'LSP error'));
      else p.resolve(msg.result);
      return;
    }
    // A server→client REQUEST (e.g. workspace/configuration, client/registerCapability)
    // — reply minimally so the server doesn't block waiting on us.
    if (msg && typeof msg.id === 'number' && typeof msg.method === 'string') {
      this.transport.send(encodeFrame({ jsonrpc: '2.0', id: msg.id, result: null }));
    }
    // Notifications (window/logMessage, textDocument/publishDiagnostics, …) → ignore.
  }

  private onClose(): void {
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('LSP server closed')); }
    this.pending.clear();
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('LSP client is closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`LSP request "${method}" timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(encodeFrame({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.transport.send(encodeFrame({ jsonrpc: '2.0', method, params }));
  }

  async initialize(rootUri: string | null): Promise<void> {
    if (this.initialized) return;
    await this.request('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: { textDocument: { hover: {}, definition: {}, references: {}, documentSymbol: {} } },
      workspaceFolders: rootUri ? [{ uri: rootUri, name: 'workspace' }] : null,
    });
    this.notify('initialized', {});
    this.initialized = true;
  }

  ensureOpen(uri: string, languageId: string, text: string): void {
    if (this.opened.has(uri)) return;
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    this.opened.add(uri);
  }

  definition(uri: string, position: LspPosition) {
    return this.request('textDocument/definition', { textDocument: { uri }, position });
  }
  references(uri: string, position: LspPosition) {
    return this.request('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration: false } });
  }
  hover(uri: string, position: LspPosition) {
    return this.request('textDocument/hover', { textDocument: { uri }, position });
  }
  documentSymbol(uri: string) {
    return this.request('textDocument/documentSymbol', { textDocument: { uri } });
  }

  async shutdown(): Promise<void> {
    try { await this.request('shutdown', null); this.notify('exit', null); } catch { /* best-effort */ }
    this.transport.close();
    this.closed = true;
  }
}
