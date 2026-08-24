/**
 * ADR-047 D2 (P2) — agents as engines: drive the MAIN loop with an installed
 * coding-agent CLI instead of an HTTP model.
 *
 * Two ways an engine model resolves to a command:
 *  1. A KNOWN adapter — claude-code / codex / opencode / gemini-cli — from the
 *     `AGENT_ADAPTERS` catalog, auto-detected on PATH. The model id is the
 *     adapter id, and its `engineArgs` are the agent's HEADLESS (one-shot)
 *     invocation. No hand-config.
 *  2. A user-declared `cli.agents.hosted[]` entry (any custom agent CLI).
 *
 * Execution is ONE-SHOT read-until-exit: spawn the CLI, deliver the prompt
 * (piped on stdin, or substituted for a `{prompt}` arg), collect ALL of stdout
 * until the process exits, and return it. This matches how real agents run
 * (`claude -p`, `codex exec`, …) — they print a multi-line answer and exit — and
 * it is the robust shape: no persistent process, no first-line race, and stdin
 * is closed cleanly (a broken pipe is swallowed) so a large prompt (we send the
 * FULL conversation each turn) can never crash the host with EPIPE.
 *
 * Honest scope (ADR D2): the external agent runs its OWN tools in its own
 * process; there is no channel to hand a BrainRouter tool call back. So an engine
 * turn is a terminal answer, and the router never fails over to or from it (a
 * subscription seat is never silently swapped for an API bill).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LLMConfig } from '../../config/config.js';
import { getCliKnobs } from '../../config/config.js';
import { getAgentAdapter, findExecutable } from '../adapters/catalog.js';

/** How the agent's stdout is read: `stdio` = the whole output is the answer; `line-json` = a JSON envelope. */
export type EngineProtocol = 'stdio' | 'line-json';

/** A resolved engine target — a command + args + output protocol. */
export interface EngineTarget {
  name: string;
  command: string;
  args: readonly string[];
  protocol: EngineProtocol;
}

/** In an engine's args, this token is replaced by the prompt (arg delivery); absent ⇒ prompt piped on stdin. */
export const PROMPT_PLACEHOLDER = '{prompt}';

/**
 * Resolve the engine target for a model id: a user-configured hosted agent
 * first, then a KNOWN adapter whose CLI is installed on PATH. Returns undefined
 * when neither matches (the caller turns that into a clear error).
 */
export function resolveEngineTarget(config: LLMConfig): EngineTarget | undefined {
  const name = (config.model || config.provider || '').trim();
  if (!name) return undefined;
  const hosted = getCliKnobs().agents.hosted.find((a) => a.name === name);
  if (hosted) {
    return { name: hosted.name, command: hosted.command, args: hosted.args, protocol: hosted.protocol };
  }
  const adapter = getAgentAdapter(name);
  if (adapter?.engineArgs && findExecutable(adapter.command)) {
    return { name: adapter.id, command: adapter.command, args: [...adapter.engineArgs], protocol: 'stdio' };
  }
  return undefined;
}

/**
 * Flatten a chat-message array into a single prompt an external agent can read.
 * BrainRouter passes the FULL conversation each turn, so the agent sees the whole
 * context here rather than relying on its own cross-turn memory.
 */
export function flattenMessagesToPrompt(messages: readonly unknown[]): string {
  const lines: string[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as { role?: unknown; content?: unknown };
    const role = typeof m.role === 'string' ? m.role : 'user';
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : '')).join('')
        : m.content == null ? '' : JSON.stringify(m.content);
    if (content.trim()) lines.push(`${role.toUpperCase()}: ${content.trim()}`);
  }
  return lines.join('\n\n');
}

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
        env: { ...process.env, BRAINROUTER_ENGINE_AGENT: target.name },
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

/** The transport-layer return shape shared with `callOpenAI` — an engine turn is a terminal answer. */
export interface EngineTurnResult {
  content: string;
  toolCalls: undefined;
  usage: undefined;
  finishReason: 'stop';
}

/**
 * The engine hand-off used by `callOpenAI` / `callOpenAIStream`. Resolves the
 * engine target, runs the turn, emits the whole answer as ONE stream delta (when
 * a streaming caller passed a handler), and returns the terminal result shape.
 */
export async function callExternalAgentEngine(
  config: LLMConfig,
  messages: readonly unknown[],
  options: EngineRunOptions & { onTextDelta?: (delta: string) => void } = {},
): Promise<EngineTurnResult> {
  const target = resolveEngineTarget(config);
  if (!target) {
    const name = (config.model || config.provider || '').trim();
    const adapter = getAgentAdapter(name);
    const hint = adapter?.engineArgs
      ? `"${name}" is a known agent but its CLI ('${adapter.command}') was not found on PATH — install it, or declare it under cli.agents.hosted[].`
      : `declare it under cli.agents.hosted[], or use a known agent id (claude-code, codex, opencode, gemini-cli).`;
    throw new Error(`engine model "${name}" is not available — ${hint}`);
  }
  const output = await runExternalAgentTurn(target, flattenMessagesToPrompt(messages), options);
  if (output && options.onTextDelta) options.onTextDelta(output);
  return { content: output, toolCalls: undefined, usage: undefined, finishReason: 'stop' };
}
