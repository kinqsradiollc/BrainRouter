/**
 * ADR-050 P1 — the fallback transport: today's one-shot behaviour expressed as a
 * session.
 *
 * `open`/`close` are structural — there is no persistent process. Each `prompt`
 * spawns the CLI, delivers the WHOLE prompt (for this transport the caller still
 * flattens the full conversation), reads stdout until exit, and emits it as one
 * `text` event. No resume, no incrementality — that is exactly what the
 * structured transports (P2) add. Behaviour is byte-identical to the pre-ADR-050
 * engine, so the seam ships with every agent working unchanged.
 */
import { spawn } from 'node:child_process';
import { runExternalAgentTurn, type EngineTarget } from './oneShotSpawn.js';
import type {
  AgentSessionDeps,
  AgentSessionHandlers,
  AgentSessionPort,
  AgentSessionSpec,
  AgentSessionTurn,
  SessionStopReason,
} from './types.js';

export class OneShotStdioSession implements AgentSessionPort {
  readonly transport = 'stdio-oneshot' as const;
  /** A one-shot spawn has no persistent session id to resume. */
  readonly resumeCursor = undefined;
  private turnAbort?: AbortController;

  constructor(
    private readonly spec: AgentSessionSpec,
    private readonly deps: AgentSessionDeps = {},
  ) {}

  async open(): Promise<void> {
    /* no persistent process for a one-shot transport */
  }

  async prompt(text: string, handlers: AgentSessionHandlers): Promise<AgentSessionTurn> {
    this.turnAbort = new AbortController();
    // The turn aborts on either the caller's signal or our own interrupt()/close().
    const parts = [handlers.signal, this.turnAbort.signal].filter((s): s is AbortSignal => !!s);
    const signal = parts.length === 1 ? parts[0]! : AbortSignal.any(parts);
    const target: EngineTarget = {
      name: this.spec.command,
      command: this.spec.command,
      args: this.spec.args,
      protocol: 'stdio',
    };
    try {
      const out = await runExternalAgentTurn(target, text, {
        signal,
        spawnImpl: this.deps.spawnImpl ?? spawn,
        cwd: this.spec.cwd,
      });
      if (out) handlers.onEvent({ kind: 'text', delta: out });
      handlers.onEvent({ kind: 'done', reason: 'stop' });
      return { text: out, reason: 'stop' };
    } catch (err) {
      const reason: SessionStopReason = signal.aborted ? 'interrupted' : 'error';
      const message = err instanceof Error ? err.message : String(err);
      handlers.onEvent({ kind: 'done', reason, error: message });
      // Uniform seam: we resolve (never throw) so all transports look alike; a
      // terminal caller (the engine) turns reason !== 'stop' back into a throw.
      return { text: '', reason };
    }
  }

  async interrupt(): Promise<void> {
    this.turnAbort?.abort();
  }

  async close(): Promise<void> {
    this.turnAbort?.abort();
  }
}
