// ADR-041 D8 Phase 2 — the first read-only tool migrated with a non-empty
// BuiltinToolHost. `research_brief` reads only `workspaceRoot` + `sessionKey` off
// the Agent, so it is the smallest honest increment of the host surface: the two
// most-common fields, added and cited, proving the god-object-narrowing pattern
// before the larger read-only tier follows. Body is the former case verbatim
// (`this.x` → `ctx.host.x`).

import { formatBrief } from '../../../research/evidenceLedger.js';
import { setQuestion, readLedger } from '../../../research/researchStore.js';
import { listConnectors } from '../../../connectors/index.js';
import { runExtractResult } from '../../../tool/result/extractResult.js';
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

  connector_list: async ({ args, host }) => {
    const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : undefined;
    const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : undefined;
    const connectors = listConnectors(host.workspaceRoot, {
      source: source as never,
      status: status as never,
    }).map((connector) => ({
      id: connector.id,
      source: connector.source,
      status: connector.status,
      lastRunAt: connector.lastRunAt ?? null,
      lastError: connector.lastError ?? null,
    }));
    return JSON.stringify(connectors, null, 2);
  },

  extract_result: async ({ args, host }) => {
    const resultRef = String(args.resultRef ?? '').trim();
    if (!resultRef) throw new Error('extract_result requires a resultRef.');
    const out = runExtractResult(
      {
        resultRef,
        query: typeof args.query === 'string' ? args.query : undefined,
        maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
      },
      host.resultCache,
    );
    return out.returned;
  },
};
