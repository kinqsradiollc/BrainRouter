// ADR-041 D8 — the native-terminal (PTY) reads. terminal_list / terminal_read are
// available ONLY in the active top-level local Desktop session (the same gate the
// runtime enforced: a terminalUsePort must exist and the agent must be the
// non-silent, depth-0, non-worker session). Bodies are the former case bodies
// verbatim (`this.x` -> `host.x`). terminal_write (an approval prompt) migrates
// separately with the interaction ports.

import { resolveActiveMode } from '../../../session/state/sessionModeStore.js';
import type { BuiltinToolHandler } from './registry.js';

export const terminalHandlers: Record<string, BuiltinToolHandler> = {
  terminal_list: async ({ host }) => {
        if (!host.terminalUsePort || host.silent || host.agentDepth !== 0 || host.tier === 'worker') {
          return 'terminal_list is unavailable outside the active top-level local Desktop session.';
        }
        return JSON.stringify(host.terminalUsePort.list(), null, 2);  },

  terminal_read: async ({ args, host }) => {
        if (!host.terminalUsePort || host.silent || host.agentDepth !== 0 || host.tier === 'worker') {
          return 'terminal_read is unavailable outside the active top-level local Desktop session.';
        }
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('Missing parameter "id" for terminal_read.');
        const maxChars = Math.max(1, Math.min(20_000, Math.floor(Number(args.maxChars) || 12_000)));
        const session = host.terminalUsePort.list().find((entry: { id: string }) => entry.id === id);
        if (!session) return JSON.stringify({ id, found: false, chunk: '', nextOffset: 0, alive: false });
        const requested = args.fromOffset === undefined
          ? Math.max(session.start, session.next - maxChars)
          : Math.max(0, Math.floor(Number(args.fromOffset) || 0));
        const result = host.terminalUsePort.read(id, requested);
        const plain = String(result.chunk ?? '')
          .replace(/\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
          .replace(/\r\n?/g, '\n');
        const chunk = plain.length > maxChars ? plain.slice(-maxChars) : plain;
        return JSON.stringify({
          id,
          found: true,
          chunk,
          nextOffset: result.next,
          alive: result.alive,
          dropped: result.dropped,
        }, null, 2);  },

  terminal_write: async ({ args, host }) => {
        if (!host.terminalUsePort || host.silent || host.agentDepth !== 0 || host.tier === 'worker') {
          return 'terminal_write is unavailable outside the active top-level local Desktop session.';
        }
        const id = String(args.id ?? '').trim();
        const data = String(args.data ?? '');
        if (!id) throw new Error('Missing parameter "id" for terminal_write.');
        if (!data) throw new Error('Missing parameter "data" for terminal_write.');
        if (data.length > 4_000) return 'terminal_write rejected: input exceeds 4000 characters.';
        const activeMode = resolveActiveMode(host.workspaceRoot, host.sessionKey);
        if (activeMode.executionMode !== 'fast') {
          const approved = host.interactionPort
            ? await host.interactionPort.confirm({
                title: 'Send input to native terminal?',
                detail: `Terminal ${id}\n\n${data}`,
                dangerous: false,
                tool: 'terminal_write',
              })
            : await host.prompter.askYesNo(`Send this input to terminal ${id}?\n${data}\n(y/N) `, false);
          if (!approved) return 'terminal_write rejected by user.';
        }
        return JSON.stringify({ id, written: host.terminalUsePort.write(id, data) });  },
};