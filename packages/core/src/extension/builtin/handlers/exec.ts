// ADR-041 D8 — the exec family. task_output reads incremental output from a
// background run_command; it is gated by the inherited-execution-authority guard
// (reviewed execution has no execution-owned background pids). It carries no
// approval/lease of its own, so it migrates verbatim ahead of the run_command
// keystone that will front the mutating exec tools with the shared guard pipeline.

import { readBackgroundOutput, killBackgroundShell } from '../../../exec/runtime/backgroundShell.js';
import type { BuiltinToolHandler } from './registry.js';

export const execHandlers: Record<string, BuiltinToolHandler> = {
  task_output: async ({ args, host }) => {
    // CC-P11.1 — incremental output of a background run_command.
    if (host.inheritedExecutionAuthorityGuard()) {
      throw new Error('task_output is unavailable inside reviewed execution because background process ids are not execution-owned.');
    }
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('task_output requires an id (from run_command background:true).');
    const fromByte = typeof args.fromByte === 'number' && args.fromByte >= 0 ? Math.floor(args.fromByte) : 0;
    const out = readBackgroundOutput(id, fromByte);
    if (!out) return JSON.stringify({ id, found: false, note: 'Unknown background run (it dies with the CLI process).' });
    return JSON.stringify(out);
  },

  kill_command: async ({ args, host }) => {
    if (host.inheritedExecutionAuthorityGuard()) {
      throw new Error('kill_command is unavailable inside reviewed execution because background process ids are not execution-owned.');
    }
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('kill_command requires an id (from run_command background:true).');
    const signal = args.signal === 'SIGKILL' || args.signal === 'SIGINT' ? args.signal : 'SIGTERM';
    const killed = killBackgroundShell(id, signal);
    return JSON.stringify({ id, killed, signal, ...(killed ? {} : { note: 'No running background command with that id (already exited, or unknown id).' }) });
  },
};
