/**
 * ADR-040 A40-7 — a resumed run RE-ATTACHES to its durable record and CONTINUES
 * the event stream, instead of exclusive-creating a second one (which the store
 * correctly refuses) or restarting the sequence (which would collide eventIds).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PhaseExecution, PhasePlanExecution } from '../orchestration/workflow/phaseOrchestrator.js';
import type { WorkflowPhase } from '../orchestration/workflow/phasePlan.js';
import { canonicalPhasePlanEmitter } from '../orchestration/execution/phasePlanAdapter.js';
import { readDurableRunSafe, readDurableRunResumeState } from '../orchestration/execution/runStore.js';

function tmpWs(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'br-resume-')); }
function phase(id: string): WorkflowPhase { return { id, title: id } as WorkflowPhase; }
function exec(id: string, status: PhaseExecution['status']): PhaseExecution {
  return { id, title: id, status, children: [], output: '' };
}
const BASE = { executionId: 'exec-r', sessionKey: 's', startedAt: '2026-08-16T00:00:00.000Z', runId: 'run-r' };

test('a resumed emitter re-attaches to the SAME durable run and continues the sequence', () => {
  const workspaceRoot = tmpWs();
  // Fresh run: create the durable record + emit a phase, then leave it (interrupted).
  const fresh = canonicalPhasePlanEmitter({ ...BASE, workspaceRoot });
  fresh.hooks.onPhaseStart?.(phase('plan'), 0, 2);
  fresh.hooks.onPhaseComplete?.(exec('plan', 'completed'));
  const priorLast = (readDurableRunResumeState(workspaceRoot, 'run-r')!.resumeState as { lastSequence: number }).lastSequence;
  assert.ok(priorLast >= 3, 'the interrupted run advanced the sequence'); // running + start + complete

  const runsDir = path.join(workspaceRoot, '.brainrouter', 'runs');
  const dirsBefore = fs.readdirSync(runsDir);

  // Resume: RE-ATTACH. It must not create a second run dir, and its first event
  // must continue past the interrupted run's last sequence, not restart at 1.
  const resumed = canonicalPhasePlanEmitter({ ...BASE, workspaceRoot, resume: true });
  const firstResumeSeq = resumed.events()[0]?.executionSequence ?? 0;
  assert.ok(firstResumeSeq > priorLast, `resumed events continue the stream (${firstResumeSeq} > ${priorLast})`);
  resumed.hooks.onPhaseStart?.(phase('build'), 1, 2);
  resumed.hooks.onPhaseComplete?.(exec('build', 'completed'));
  resumed.finish({ status: 'completed', phases: [] } as PhasePlanExecution);

  assert.deepEqual(fs.readdirSync(runsDir), dirsBefore, 'no second run directory was created');
  const safe = readDurableRunSafe(workspaceRoot, 'run-r')!;
  assert.equal(safe.status, 'succeeded', 'the reattached run finalized on the SAME record');
  const finalLast = (readDurableRunResumeState(workspaceRoot, 'run-r')!.resumeState as { lastSequence: number }).lastSequence;
  assert.ok(finalLast > priorLast, 'the durable sequence advanced through the resume');
});

test('resume with NO existing record falls back to a fresh start rather than throwing', () => {
  const workspaceRoot = tmpWs();
  const resumed = canonicalPhasePlanEmitter({ ...BASE, workspaceRoot, resume: true });
  resumed.hooks.onPhaseStart?.(phase('only'), 0, 1);
  resumed.finish({ status: 'completed', phases: [] } as PhasePlanExecution);
  assert.equal(readDurableRunSafe(workspaceRoot, 'run-r')!.status, 'succeeded');
});
