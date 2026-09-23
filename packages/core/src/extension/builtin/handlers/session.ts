// ADR-041 D8 — session/workflow-state writers. These tools mutate per-session
// state (steering receipts, workflow run progress) through workspaceRoot +
// sessionKey only — both already on BuiltinToolHost — so they add zero host
// surface. Bodies are the former case bodies verbatim (`this.x` → `ctx.host.x`).

import { reconcileSteeringReceipt, type SteeringClassification } from '../../../task/steeringReceiptStore.js';
import { getCurrentWorkflow } from '../../../workflow/run/workflowArtifacts.js';
import { advanceRunStep, summarizeRun } from '../../../workflow/run/workflowRun.js';
import { CHAPTER_ENTRY_NAME, chapterEntryContent } from '../../../session/transcript/chapterMarks.js';
import { blockGoal, completeGoal } from '../../../goal/store/goalStore.js';
import { readPlan, updatePlan, formatPlan } from '../../../task/taskStore.js';
import { applySteeringPlanRevision } from '../../../task/steeringReceiptStore.js';
import { subscribeIdleNotice } from '../../../session/messaging/idleNotifyStore.js';
import type { BuiltinToolHandler } from './registry.js';

export const sessionHandlers: Record<string, BuiltinToolHandler> = {
  // ADR-052 P4.2 — subscribe THIS session to a one-shot notice when another local
  // session next goes idle, instead of polling it.
  notify_when_idle: async ({ args, host }) => {
    const target = String(args.target_session ?? '').trim();
    if (!target) throw new Error('notify_when_idle requires target_session (the session key to watch).');
    const ok = subscribeIdleNotice(host.workspaceRoot, target, host.sessionKey, Date.now());
    return ok
      ? JSON.stringify({ subscribed: true, target, note: `One message will arrive when ${target} next goes idle.` })
      : JSON.stringify({ subscribed: false, error: 'invalid target (empty, or the same session)' });
  },
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

  goal_complete: async ({ args, host }) => {
    const proof = String(args.proof ?? '').trim();
    if (!proof) throw new Error('goal_complete requires a non-empty proof.');
    // Plan-honesty guard: refuse to mark the goal complete while the active plan
    // still has pending / in_progress items. The model built that plan as its own
    // contract — declaring done while items remain open is misleading.
    const plan = readPlan(host.workspaceRoot, host.sessionKey);
    const open = plan.items.filter((i) => i.status !== 'completed');
    if (open.length > 0) {
      const open_summary = open
        .map((i) => `  - [${i.status === 'in_progress' ? '⏳' : '☐'}] ${i.step}`)
        .join('\n');
      throw new Error(
        `goal_complete refused: the active plan still has ${open.length} incomplete item(s):\n${open_summary}\n\n` +
        `Do ONE of:\n` +
        `  1. Finish the remaining work, then call update_plan to mark those items completed.\n` +
        `  2. If you decided to drop them, call update_plan FIRST and mark them completed with a brief explanation (the plan is your honest record — leaving items pending while declaring done is misleading).\n` +
        `  3. Call goal_blocked instead if no defensible path remains.\n\n` +
        `Then retry goal_complete in the same response as the user-visible prose summary.`
      );
    }
    const goal = completeGoal(host.workspaceRoot, host.sessionKey, proof);
    if (!goal) return 'No active goal to complete.';
    host.lastGoalTransition = 'complete';
    return `Goal marked complete. Proof: ${proof}`;
  },

  goal_blocked: async ({ args, host }) => {
    const reason = String(args.reason ?? '').trim();
    if (!reason) throw new Error('goal_blocked requires a non-empty reason.');
    const needed = String(args.needed ?? '').trim();
    const note = needed ? `${reason} (needed: ${needed})` : reason;
    const goal = blockGoal(host.workspaceRoot, host.sessionKey, note);
    if (!goal) return 'No active goal to block.';
    host.lastGoalTransition = 'blocked';
    return `Goal marked blocked. Reason: ${note}`;
  },

  update_plan: async ({ args, host }) => {
    const state = updatePlan(host.workspaceRoot, {
      explanation: args.explanation,
      ...(Array.isArray(args.phases)
        ? { phases: args.phases }
        : { plan: args.plan }),
    }, host.sessionKey);
    if (typeof args.steeringReceiptId === 'string' && args.steeringReceiptId.trim()) {
      applySteeringPlanRevision(
        host.workspaceRoot,
        host.sessionKey,
        args.steeringReceiptId.trim(),
        state,
      );
    }
    // Auto mode has no approval prompt — record an auto-approval into the
    // plan history when this establishes a new plan version.
    host.maybeAutoApprovePlan(state);
    return formatPlan(state);
  },
};
