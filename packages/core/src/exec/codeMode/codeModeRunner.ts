/**
 * ADR-041 A41-15 (W3) — the default Code Mode runner (parent controller).
 *
 * Runs the `run_code` program as a local Node subprocess in its OWN process group
 * (`detached`), so a budget breach or abort is an unforgeable group-SIGKILL. The
 * program's SOURCE goes in on the child's stdin; its stdout/stderr are captured
 * (char-capped); the tool-binding control plane is inherited fd 3 (NDJSON). Every
 * `agent.<tool>()` call the child makes is handed to the caller's `dispatch` — the
 * runner is pure transport and enforcement; `dispatch` is the security-bearing
 * re-entry into the D8 pipeline.
 *
 * First slice: the child runs env-scrubbed but NOT OS-sandbox-wrapped, so the
 * `run_code` handler refuses whenever the sandbox would be enforced — keeping it
 * strictly ≤ `run_command`'s exposure in every mode. Wrapping the child in the
 * same sandbox as `run_command` (to lift that refusal) is the documented follow-on.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { createLineFramer, encodeLine, type ChildMessage } from './protocol.js';
import type { CodeRunKillReason } from './budget.js';
import type { CodeRunnerPort, CodeRunOptions, CodeRunResult, CodeToolDispatch } from './codeRunnerPort.js';

/**
 * The compiled child entry. In production `import.meta.url` is under `dist/`, so
 * the sibling `.js` is right there. Under `tsx` (dev/tests) it resolves under
 * `src/`, where only the `.ts` exists — fall back to the built `dist/` copy so a
 * `npm run build`-then-test flow works. Computed per call so the fs check is fresh.
 */
function resolveChildEntry(): string {
  const direct = fileURLToPath(new URL('./runCodeChild.js', import.meta.url));
  if (fs.existsSync(direct)) return direct;
  return direct.replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`);
}

class CodeModeRunner implements CodeRunnerPort {
  async runCode(source: string, options: CodeRunOptions, dispatch: CodeToolDispatch): Promise<CodeRunResult> {
    const { budget } = options;
    return new Promise<CodeRunResult>((resolve) => {
      const child = spawn(process.execPath, [resolveChildEntry(), JSON.stringify(options.toolNames ?? [])], {
        cwd: options.workspaceRoot,
        env: options.scrubbedEnv ?? process.env,
        // stdin=source, stdout/err=output, fd3=control child→parent, fd4=control parent→child
        // (extra stdio pipes are unidirectional, so control uses two of them).
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        detached: true, // own process group ⇒ we can group-SIGKILL grandchildren too
      });

      let output = '';
      let outputTruncated = false;
      let toolCalls = 0;
      let returnValue = '';
      let programError: string | undefined;
      let killReason: CodeRunKillReason | undefined;
      let settled = false;
      let inFlight = 0;

      const wallClock = setTimeout(() => kill('wall-clock'), budget.wallClockMs);
      let deadMan = setTimeout(() => kill('starved'), budget.heartbeatGraceMs);
      const resetDeadMan = (): void => {
        clearTimeout(deadMan);
        deadMan = setTimeout(() => kill('starved'), budget.heartbeatGraceMs);
      };

      const onAbort = (): void => kill('aborted');
      options.signal?.addEventListener('abort', onAbort, { once: true });

      function kill(reason: CodeRunKillReason): void {
        if (killReason || settled) return;
        killReason = reason;
        try {
          // Negative pid → the whole group (child + any grandchildren it spawned).
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }

      function finish(): void {
        if (settled) return;
        settled = true;
        clearTimeout(wallClock);
        clearTimeout(deadMan);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ returnValue, output, outputTruncated, toolCalls, killReason, error: programError });
      }

      function appendOutput(chunk: string): void {
        if (outputTruncated) return;
        const room = budget.maxOutputChars - output.length;
        if (chunk.length <= room) { output += chunk; return; }
        output += chunk.slice(0, Math.max(0, room));
        outputTruncated = true;
        kill('output-overflow');
      }
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', appendOutput);
      child.stderr?.on('data', appendOutput);

      const controlIn = child.stdio[3] as NodeJS.ReadableStream | null; // child → parent
      const controlOut = child.stdio[4] as NodeJS.WritableStream | null; // parent → child
      const framer = createLineFramer<ChildMessage>();

      async function handleCall(id: number, tool: string, args: Record<string, unknown>): Promise<void> {
        if (killReason || settled) return;
        toolCalls++;
        if (toolCalls > budget.maxToolCalls) { kill('max-tool-calls'); return; }
        // Bounded in-flight: dispatch is serialized by the single-threaded parent
        // authorization state, so this is a safety cap, not a throughput knob.
        inFlight++;
        let ok = true;
        let value: string;
        try {
          value = await dispatch(tool, args);
        } catch (err) {
          ok = false;
          value = err instanceof Error ? err.message : String(err);
        } finally {
          inFlight--;
        }
        if (killReason || settled) return;
        try { controlOut?.write(encodeLine({ t: 'result', id, ok, value })); } catch { /* channel gone */ }
      }

      if (controlIn) {
        (controlIn as NodeJS.ReadableStream).setEncoding?.('utf8');
        controlIn.on('data', (chunk: string | Buffer) => {
          for (const message of framer.push(String(chunk)).messages) {
            switch (message.t) {
              case 'call':
                if (inFlight < budget.maxInFlight) void handleCall(message.id, message.tool, message.args);
                else { try { controlOut?.write(encodeLine({ t: 'result', id: message.id, ok: false, value: 'code-mode: too many concurrent tool calls' })); } catch { /* ignore */ } }
                break;
              case 'heartbeat':
                resetDeadMan();
                if (message.activeMs > budget.computeMs) kill('compute');
                break;
              case 'done':
                returnValue = message.result;
                break;
              case 'error':
                programError = message.message;
                break;
            }
          }
        });
        controlIn.on('error', () => { /* child tore down the channel; exit handler settles */ });
      }

      // Feed the program source, then close stdin so the child's readAll resolves.
      try {
        child.stdin?.write(source);
        child.stdin?.end();
      } catch {
        kill('aborted');
      }

      child.on('error', (err) => { programError ??= err.message; finish(); });
      child.on('close', () => finish());
    });
  }
}

/** The default Code Mode runner binding (local subprocess). */
export const codeModeRunner: CodeRunnerPort = new CodeModeRunner();
