// ADR-041 D8 Phase 37 — computer_use (desktop control). Gated hard: disabled unless the
// cli knob is on, refused for silent child agents and remote-brain sessions, capped per turn,
// and every mutating/dangerous action asks for confirmation unless the session is in fast mode.
// New host surface: computerUsePort (the desktop-control capability) + the MUTABLE
// computerActionsThisTurn counter (the per-turn cap). Body is the former switch case verbatim
// (this.x -> ctx.host.x).

import { getCliKnobs, isRemoteBrainUrl } from '../../../config/config.js';
import { evaluateDestructiveAction, isComputerActionMutating, validateComputerAction } from '../../../agent/fs/computerUse.js';
import { resolveActiveMode } from '../../../session/state/sessionModeStore.js';
import type { BuiltinToolHandler } from './registry.js';

// Per-turn action cap (moved verbatim from runtime.ts with its sole consumer).
const MAX_COMPUTER_ACTIONS_PER_TURN = 20;

export const computerHandlers: Record<string, BuiltinToolHandler> = {
  computer_use: async ({ args, host }) => {
        if (!getCliKnobs().computerUse.enabled) return 'computer_use is disabled. Set cli.computerUse.enabled=true to enable it.';
        if (!host.computerUsePort) return 'computer_use is unavailable in this runtime.';
        if (host.silent) return 'computer_use denied: silent child agents cannot control the desktop.';
        if (isRemoteBrainUrl(getCliKnobs().brainUrl)) return 'computer_use denied: remote-brain sessions cannot control the local desktop.';
        if (host.computerActionsThisTurn >= MAX_COMPUTER_ACTIONS_PER_TURN) {
          return `computer_use denied: per-turn action cap (${MAX_COMPUTER_ACTIONS_PER_TURN}) reached.`;
        }
        const validation = validateComputerAction(args);
        if (!validation.ok) return `computer_use invalid action: ${validation.error}`;
        const action = validation.action;
        host.computerActionsThisTurn += 1;

        if (action.action === 'screenshot') {
          try {
            const image = await host.computerUsePort.screenshot();
            return JSON.stringify({
              success: true,
              action: 'screenshot',
              image,
              note: 'Screenshot captured at full logical resolution.',
            }, null, 2);
          } catch (err: any) {
            return JSON.stringify({
              success: false,
              action: 'screenshot',
              permissionDenied: /permission|screen recording|accessibility/i.test(String(err?.message ?? err)),
              error: err?.message ?? String(err),
            }, null, 2);
          }
        }

        const destructive = evaluateDestructiveAction(action, { userIntent: host.lastUserPrompt });
        const activeMode = resolveActiveMode(host.workspaceRoot, host.sessionKey);
        const shouldAsk = destructive.dangerous || (isComputerActionMutating(action.action) && activeMode.executionMode !== 'fast');
        if (shouldAsk) {
          const detail = `${JSON.stringify(action, null, 2)}${destructive.reason ? `\n\n${destructive.reason}` : ''}`;
          const approved = host.interactionPort
            ? await host.interactionPort.confirm({ title: 'Allow computer control?', detail, dangerous: destructive.dangerous, tool: 'computer_use' })
            : await host.prompter.askYesNo(`${detail}\nAllow computer control? (y/N) `, false);
          if (!approved) return 'computer_use rejected by user.';
        }

        const result = await host.computerUsePort.act(action);
        return JSON.stringify({ action: action.action, ...result }, null, 2);
  },
};
