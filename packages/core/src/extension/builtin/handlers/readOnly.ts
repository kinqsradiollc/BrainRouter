// ADR-041 D8 Phase 2 — the first read-only tool migrated with a non-empty
// BuiltinToolHost. `research_brief` reads only `workspaceRoot` + `sessionKey` off
// the Agent, so it is the smallest honest increment of the host surface: the two
// most-common fields, added and cited, proving the god-object-narrowing pattern
// before the larger read-only tier follows. Body is the former case verbatim
// (`this.x` → `ctx.host.x`).

import { formatBrief } from '../../../research/evidenceLedger.js';
import { setQuestion, readLedger } from '../../../research/researchStore.js';
import type { BuiltinToolHandler } from './registry.js';

export const readOnlyHandlers: Record<string, BuiltinToolHandler> = {
  research_brief: async ({ args, host }) => {
    if (typeof args.question === 'string' && args.question.trim()) {
      setQuestion(host.workspaceRoot, host.sessionKey, args.question);
    }
    const ledger = readLedger(host.workspaceRoot, host.sessionKey);
    if (!ledger) return 'No research ledger yet — record evidence with research_note first.';
    return formatBrief(ledger);
  },
};
