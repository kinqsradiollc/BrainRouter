/**
 * ADR-050 P2a — the Claude Code `stream-json` transport.
 *
 * Drives a PERSISTENT `claude -p --input-format stream-json --output-format
 * stream-json --verbose` session: each `prompt` writes one stream-json user
 * message, and the CLI emits JSONL events we normalize — `system/init` captures
 * the resumable session id, `assistant` text/tool_use blocks stream as text/tool
 * events, and `result` settles the turn (with `is_error` → error). The captured
 * session id is the `resumeCursor`; a CLI that exits per turn is handled the same
 * way a persistent one is — the next prompt reopens with `--resume <id>`.
 *
 * The line PARSER is a pure function (tested against real message shapes); the
 * session is a thin state machine over `LineStdioProcess`.
 */
import { LineStdioProcess } from './lineStdioProcess.js';
import type {
  AgentSessionDeps,
  AgentSessionHandlers,
  AgentSessionPort,
  AgentSessionSpec,
  AgentSessionTurn,
  SessionStopReason,
} from './types.js';

/** One normalized item from a stream-json line (an assistant line yields several). */
export type ClaudeStreamParsed =
  | { t: 'session'; sessionId: string }
  | { t: 'text'; text: string }
  | { t: 'tool'; name: string }
  | { t: 'result'; text: string; isError: boolean; sessionId?: string };

/** Pure: normalize ONE stream-json line into zero or more parsed items. */
export function parseClaudeStreamLine(line: string): ClaudeStreamParsed[] {
  const out: ClaudeStreamParsed[] = [];
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { return out; }
  if (!msg || typeof msg !== 'object') return out;
  const m = msg as Record<string, any>;
  if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
    out.push({ t: 'session', sessionId: m.session_id });
  } else if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
    for (const block of m.message.content as Array<Record<string, any>>) {
      if (block?.type === 'text' && typeof block.text === 'string') out.push({ t: 'text', text: block.text });
      else if (block?.type === 'tool_use' && typeof block.name === 'string') out.push({ t: 'tool', name: block.name });
    }
  } else if (m.type === 'result') {
    const isError = m.is_error === true || (typeof m.subtype === 'string' && m.subtype.startsWith('error'));
    out.push({
      t: 'result',
      text: typeof m.result === 'string' ? m.result : '',
      isError,
      ...(typeof m.session_id === 'string' ? { sessionId: m.session_id } : {}),
    });
  }
  return out;
}

const BASE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

interface ActiveTurn {
  onEvent: (e: import('./types.js').AgentSessionEvent) => void;
  resolve: (t: AgentSessionTurn) => void;
  text: string;
  done: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ClaudeStreamJsonSession implements AgentSessionPort {
  readonly transport = 'claude-stream-json' as const;
  private _resumeCursor?: string;
  private proc?: LineStdioProcess;
  private stderr = '';
  private active?: ActiveTurn;

  constructor(private readonly spec: AgentSessionSpec, private readonly deps: AgentSessionDeps = {}) {
    this._resumeCursor = spec.resumeCursor;
  }

  get resumeCursor(): string | undefined { return this._resumeCursor; }

  async open(): Promise<void> {
    if (this.proc?.running) return;
    const args = [...BASE_ARGS, ...(this._resumeCursor ? ['--resume', this._resumeCursor] : [])];
    this.proc = new LineStdioProcess(
      this.spec.command, args,
      {
        onLine: (line) => this.onLine(line),
        onStderr: (t) => { this.stderr += t; },
        onExit: (code) => this.onExit(code),
        onError: (err) => { if (this.active && !this.active.done) this.settle('error', err.message); },
      },
      { ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}), ...(this.spec.env ? { env: this.spec.env } : {}) },
      this.deps,
    );
    this.proc.start();
  }

  private onLine(line: string): void {
    for (const p of parseClaudeStreamLine(line)) {
      if (p.t === 'session') {
        this._resumeCursor = p.sessionId;
        this.active?.onEvent({ kind: 'session', sessionId: p.sessionId });
      } else if (p.t === 'text' && this.active && !this.active.done) {
        this.active.text += p.text;
        this.active.onEvent({ kind: 'text', delta: p.text });
      } else if (p.t === 'tool' && this.active && !this.active.done) {
        this.active.onEvent({ kind: 'tool', phase: 'start', name: p.name });
      } else if (p.t === 'result') {
        if (p.sessionId) this._resumeCursor = p.sessionId;
        this.settle(p.isError ? 'error' : 'stop', p.isError ? (this.stderr.trim() || 'agent reported an error') : undefined, p.text);
      }
    }
  }

  private settle(reason: SessionStopReason, error?: string, resultText?: string): void {
    const a = this.active;
    if (!a || a.done) return;
    a.done = true;
    // If the assistant streamed no text but the result carries a final answer, use it.
    let text = a.text;
    if (!text && resultText) { text = resultText; a.onEvent({ kind: 'text', delta: resultText }); }
    a.onEvent({ kind: 'done', reason, ...(error ? { error } : {}) });
    if (a.signal && a.onAbort) a.signal.removeEventListener('abort', a.onAbort);
    this.active = undefined;
    a.resolve({ text, reason });
  }

  private onExit(code: number | null): void {
    if (this.active && !this.active.done) {
      this.settle(code === 0 ? 'stop' : 'error', code === 0 ? undefined : (this.stderr.trim() || `claude exited (${code ?? 'null'})`));
    }
  }

  async prompt(text: string, handlers: AgentSessionHandlers): Promise<AgentSessionTurn> {
    if (!this.proc?.running) await this.open();
    this.stderr = '';
    return new Promise<AgentSessionTurn>((resolve) => {
      const onAbort = (): void => this.settle('interrupted');
      this.active = { onEvent: handlers.onEvent, resolve, text: '', done: false, ...(handlers.signal ? { signal: handlers.signal, onAbort } : {}) };
      if (handlers.signal) {
        if (handlers.signal.aborted) { this.settle('interrupted'); return; }
        handlers.signal.addEventListener('abort', onAbort, { once: true });
      }
      const message = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
      this.proc!.write(message);
    });
  }

  async interrupt(): Promise<void> {
    // Best-effort protocol interrupt (control_request), then the turn ends
    // interrupted; the caller escalates to close() to kill the process.
    try {
      this.proc?.write(JSON.stringify({ type: 'control_request', request: { subtype: 'interrupt' } }));
    } catch { /* stream closed */ }
    this.settle('interrupted');
  }

  async close(): Promise<void> {
    this.settle('interrupted');
    this.proc?.kill();
    this.proc = undefined;
  }
}
