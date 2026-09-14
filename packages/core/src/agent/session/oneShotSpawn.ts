/**
 * ADR-050 P1 — the one-shot spawn primitive.
 *
 * Extracted verbatim from the pre-ADR-050 `externalAgentEngine` so the session
 * module owns the spawn (and the engine can consume the session without a module
 * cycle). Spawns a CLI, delivers the prompt (piped on stdin, or substituted for a
 * `{prompt}` arg), collects ALL stdout until the process exits, and returns it.
 * EPIPE-safe and abort-safe: a large prompt never crashes the host, and an abort
 * kills the child.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentSessionTransport } from './types.js';

/** How the agent's stdout is read: `stdio` = the whole output is the answer; `line-json` = a JSON envelope. */
export type EngineProtocol = 'stdio' | 'line-json';

/** A resolved engine target — a command + args + output protocol. */
export interface EngineTarget {
  name: string;
  command: string;
  args: readonly string[];
  protocol: EngineProtocol;
  /** ADR-050 D5 — per-instance env (isolated home) merged over process.env at spawn. */
  env?: Record<string, string>;
  /**
   * ADR-050 D2/P4 — a live session transport DECLARED by the target itself (a
   * bring-your-own hosted agent), taking precedence over any built-in catalog
   * lookup. Absent ⇒ the engine derives the transport from the catalog adapter.
   */
  sessionTransport?: AgentSessionTransport;
  /** ADR-050 D2/P4 — args that launch the CLI in `sessionTransport` mode. */
  sessionArgs?: readonly string[];
}

/** In an engine's args, this token is replaced by the prompt (arg delivery); absent ⇒ prompt piped on stdin. */
export const PROMPT_PLACEHOLDER = '{prompt}';

/** Extract the answer from an agent's full stdout under its protocol. */
export function extractEngineOutput(stdout: string, protocol: EngineProtocol): { output: string; error?: string } {
  if (protocol !== 'line-json') return { output: stdout };
  // Scan from the LAST line for a JSON envelope: {output} resolves, {error} rejects.
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as { output?: unknown; error?: unknown };
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.error === 'string') return { output: '', error: parsed.error };
        if (typeof parsed.output === 'string') return { output: parsed.output };
      }
    } catch { /* not a JSON line */ }
  }
  return { output: stdout }; // no envelope → the raw output is the answer
}

export interface EngineRunOptions {
  signal?: AbortSignal;
  /** Injected for tests; defaults to node:child_process.spawn. */
  spawnImpl?: typeof spawn;
  /** Working directory for the spawned agent. Defaults to process.cwd(). */
  cwd?: string;
  /** ADR-050 D5 — per-instance env (isolated home) merged over process.env. */
  env?: Record<string, string>;
}

/**
 * Run one turn against an external agent CLI (one-shot). Spawns the command,
 * delivers the prompt, collects ALL stdout until the process exits, and resolves
 * with the answer. Kills the child on abort. EPIPE-safe: stdin is ended cleanly
 * and a broken-pipe 'error' is swallowed, so a large prompt never crashes the host.
 */
export function runExternalAgentTurn(
  target: EngineTarget,
  prompt: string,
  options: EngineRunOptions = {},
): Promise<string> {
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('external agent turn aborted')); return; }

    const usesArg = target.args.includes(PROMPT_PLACEHOLDER);
    const args = target.args.map((a) => (a === PROMPT_PLACEHOLDER ? prompt : a));

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(target.command, args, {
        cwd: options.cwd || process.cwd(),
        // Instance env (isolated home) overrides the inherited environment; the
        // engine-agent marker is stamped last so it always reflects this target.
        env: { ...process.env, ...options.env, ...target.env, BRAINROUTER_ENGINE_AGENT: target.name },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    const cleanup = (): void => { options.signal?.removeEventListener('abort', onAbort); };
    const killIfRunning = (): void => {
      try { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); } catch { /* already gone */ }
    };
    const finish = (fn: () => void): void => { if (settled) return; settled = true; cleanup(); fn(); };
    const onAbort = (): void => finish(() => { killIfRunning(); reject(new Error('external agent turn aborted')); });
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // EPIPE-safe: the agent may close stdin before we finish writing a big prompt.
    child.stdin.on('error', () => { /* broken pipe — the agent already has what it needs */ });
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))));
    child.once('exit', (code) => finish(() => {
      const parsed = extractEngineOutput(stdout, target.protocol);
      if (parsed.error) { reject(new Error(parsed.error)); return; }
      const answer = parsed.output.trim();
      if (answer) { resolve(answer); return; }
      reject(new Error(
        `external agent '${target.name}' produced no output` +
          (stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ` (exit ${code ?? 'null'})`),
      ));
    }));

    // Deliver the prompt: substituted into a {prompt} arg, else piped on stdin.
    if (!usesArg) child.stdin.write(`${prompt}\n`, () => { /* EPIPE handled by the stdin 'error' listener */ });
    child.stdin.end(); // signal EOF so the agent processes the prompt and exits
  });
}
