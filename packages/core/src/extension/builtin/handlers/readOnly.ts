// ADR-041 D8 Phase 2 — the first read-only tool migrated with a non-empty
// BuiltinToolHost. `research_brief` reads only `workspaceRoot` + `sessionKey` off
// the Agent, so it is the smallest honest increment of the host surface: the two
// most-common fields, added and cited, proving the god-object-narrowing pattern
// before the larger read-only tier follows. Body is the former case verbatim
// (`this.x` → `ctx.host.x`).

import { formatBrief, summarizeLedger } from '../../../research/evidenceLedger.js';
import { setQuestion, readLedger, appendEvidence } from '../../../research/researchStore.js';
import { listConnectors } from '../../../connectors/index.js';
import { runExtractResult } from '../../../tool/result/extractResult.js';
import { listWorktreesStructured } from '../../../worktree/concurrentWorktrees.js';
import path from 'node:path';
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

  research_note: async ({ args, host }) => {
    const claim = String(args.claim ?? '').trim();
    if (!claim) throw new Error('research_note requires a non-empty `claim`.');
    const sources = Array.isArray(args.sources) ? args.sources.map((s: any) => String(s)) : [];
    const sourceRecords = Array.isArray(args.sourceRecords)
      ? args.sourceRecords.filter((source: any) => source && typeof source === 'object').map((source: any) => ({
        url: String(source.url ?? ''),
        ...(typeof source.title === 'string' ? { title: source.title } : {}),
        ...(typeof source.publisher === 'string' ? { publisher: source.publisher } : {}),
        ...(Array.isArray(source.authors) ? { authors: source.authors.map((author: any) => String(author)) } : {}),
        ...(typeof source.publishedDate === 'string' ? { publishedDate: source.publishedDate } : {}),
        ...(typeof source.accessedAt === 'string' ? { accessedAt: source.accessedAt } : {}),
        ...(typeof source.evidence === 'string' ? { evidence: source.evidence } : {}),
        ...(typeof source.limitations === 'string' ? { limitations: source.limitations } : {}),
      }))
      : [];
    const stance = ['support', 'refute', 'unclear'].includes(String(args.stance))
      ? (String(args.stance) as 'support' | 'refute' | 'unclear')
      : undefined;
    const confidence = ['high', 'medium', 'low'].includes(String(args.confidence))
      ? (String(args.confidence) as 'high' | 'medium' | 'low')
      : undefined;
    const note = typeof args.note === 'string' ? args.note : undefined;
    const ledger = appendEvidence(host.workspaceRoot, host.sessionKey, { claim, sources, sourceRecords, stance, confidence, note });
    const s = summarizeLedger(ledger);
    return `Recorded. Ledger: ${s.total} finding${s.total === 1 ? '' : 's'} (${s.corroborated} corroborated, ${s.conflicting} conflicting, ${s.singleSource} single-source).`;
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

  worktree_list: async ({ host }) => {
    const list = listWorktreesStructured(host.workspaceRoot, undefined, { withDirty: true });
    const attached = new Set((host.attachedRoots ?? []).map((r: string) => path.resolve(r)));
    return JSON.stringify({
      primaryRoot: host.workspaceRoot,
      worktrees: list.map((w) => ({
        path: w.path,
        branch: w.branch,
        detached: w.detached || undefined,
        bare: w.bare || undefined,
        locked: w.locked || undefined,
        lockedReason: w.lockedReason,
        prunable: w.prunable || undefined,
        prunableReason: w.prunableReason,
        dirty: w.dirty,
        current: w.isSelf || undefined,
        attached: attached.has(path.resolve(w.path)) || undefined,
      })),
    }, null, 2);
  },
};
