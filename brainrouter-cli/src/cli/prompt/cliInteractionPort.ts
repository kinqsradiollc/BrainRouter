/**
 * ADR-034 — CLI adapter for Core's host-neutral interaction port.
 *
 * Ink/readline remains the presentation owner. When no interactive terminal is
 * attached, confirmations fail closed and choices dismiss instead of silently
 * authorizing a mutation.
 */

import type { AgentOptions } from '@kinqs/brainrouter-core/agent';
import { askExplicitYesNo, cliPrompter } from './cliPrompt.js';

export const cliInteractionPort: NonNullable<AgentOptions['interactionPort']> = {
  async confirm(request) {
    const detail = request.detail?.trim();
    const question = detail
      ? `${request.title}\n\n${detail}\n\nApprove? (y/N) `
      : `${request.title} (y/N) `;
    try {
      return await cliPrompter.askYesNo(question, false);
    } catch {
      return false;
    }
  },
  async choice(request) {
    try {
      const answer = await cliPrompter.askChoice(
        request.question,
        request.options,
        { header: request.header, multiSelect: request.multiSelect },
      );
      return Array.isArray(answer) ? answer : [answer];
    } catch {
      return null;
    }
  },
  async confirmExplicit(request) {
    const detail = request.detail?.trim();
    const question = detail
      ? `${request.title}\n\n${detail}\n\nApply this message? (y/N, Enter dismisses) `
      : `${request.title} (y/N, Enter dismisses) `;
    try {
      return await askExplicitYesNo(question);
    } catch {
      return 'dismissed';
    }
  },
};
