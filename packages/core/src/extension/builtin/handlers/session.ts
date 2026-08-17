// ADR-041 D8 — session/workflow-state writers. These tools mutate per-session
// state (steering receipts, workflow run progress) through workspaceRoot +
// sessionKey only — both already on BuiltinToolHost — so they add zero host
// surface. Bodies are the former case bodies verbatim (`this.x` → `ctx.host.x`).

import { reconcileSteeringReceipt, type SteeringClassification } from '../../../task/steeringReceiptStore.js';
import { getCurrentWorkflow } from '../../../workflow/run/workflowArtifacts.js';
import { advanceRunStep, summarizeRun } from '../../../workflow/run/workflowRun.js';
import { CHAPTER_ENTRY_NAME, chapterEntryContent } from '../../../session/transcript/chapterMarks.js';
import type { BuiltinToolHandler } from './registry.js';

export const sessionHandlers: Record<string, BuiltinToolHandler> = {
  mark_chapter: async ({ args, host }) => {
    // CC-P12.3 — persist a chapter marker into the session transcript.
    const title = String(args.title ?? '').trim();
    if (!title) throw new Error('mark_chapter requires a non-empty title.');
    if (title.length > 60) throw new Error('mark_chapter title must be under 60 chars.');
    const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : undefined;
    const marker = { role: 'system', name: CHAPTER_ENTRY_NAME, content: chapterEntryContent(title, summary) };
    host.recordTranscript(marker);
    return JSON.stringify({ marked: true, title, note: 'Chapter recorded — the user can browse with /chapters.' });
  },

  reconcile_steer: async ({ args, host }) => {
    const receipt = reconcileSteeringReceipt(host.workspaceRoot, host.sessionKey, {
      receiptId: String(args.receiptId ?? ''),
      classification: String(args.classification ?? '') as SteeringClassification,
      summary: String(args.summary ?? ''),
      affectedRequirementIds: Array.isArray(args.affectedRequirementIds)
        ? args.affectedRequirementIds.map(String)
        : [],
      affectedTaskIds: Array.isArray(args.affectedTaskIds)
        ? args.affectedTaskIds.map(String)
        : [],
      affectedPhaseIds: Array.isArray(args.affectedPhaseIds)
        ? args.affectedPhaseIds.map(String)
        : [],
    });
    return JSON.stringify(receipt, null, 2);
  },

  workflow_progress: async ({ args, host }) => {
    const slug = getCurrentWorkflow(host.workspaceRoot, host.sessionKey);
    if (!slug) {
      return 'No active workflow — nothing to track. (Bind one with /review, /simplify, /feature-dev, /spec, or /implement-plan.)';
    }
    const step = String(args.step ?? '').trim();
    const status = String(args.status ?? '').trim() as 'running' | 'done' | 'failed' | 'skipped';
    if (!step) throw new Error('workflow_progress requires a non-empty `step` id.');
    if (!['running', 'done', 'failed', 'skipped'].includes(status)) {
      throw new Error(`workflow_progress: status must be running|done|failed|skipped (got "${status}").`);
    }
    const run = advanceRunStep(host.workspaceRoot, slug, step, status, {
      note: args.note ? String(args.note) : undefined,
      sessionKey: host.sessionKey,
      pid: process.pid,
    });
    const { done, total } = summarizeRun(run);
    return `Workflow "${slug}": step "${step}" → ${status} (${done}/${total} done, run ${run.status}).`;
  },
};
