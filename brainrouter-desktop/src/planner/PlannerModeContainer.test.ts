/**
 * ADR-038 — Desktop Planner host integration contracts.
 *
 * These assertions pin wiring that compiles even when it silently falls out of
 * the accepted experience: the five-second active refresh bound and the block
 * reschedule path through both Electron and the deterministic browser bridge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('ADR-038 keeps active Desktop Planner reconciliation within five seconds', () => {
  const container = source('./PlannerModeContainer.tsx');
  assert.match(container, /SYNC_INTERVAL_MS\s*=\s*5_000/);
  assert.match(container, /syncInFlight\.current[\s\S]{0,400}syncAgain\.current = true/);
});

test('ADR-038 routes calendar moves through both Desktop host adapters', () => {
  assert.match(source('./PlannerModeContainer.tsx'), /rescheduleBlock:[\s\S]{0,160}'planner-reschedule-block'/);
  assert.match(source('../../electron/host/queries.ts'), /'planner-reschedule-block'[\s\S]{0,500}plannerUpdateBlock/);
  assert.match(source('../devBridge/queries.ts'), /'planner-reschedule-block'[\s\S]{0,600}queueDevPlannerChange/);
});

test('ADR-038 serializes every Desktop Planner store mutation with reconciliation', () => {
  const host = source('../../electron/host/queries.ts');
  for (const action of [
    'planner-read',
    'planner-add',
    'planner-update',
    'planner-delete',
    'planner-schedule',
    'planner-schedule-at',
    'planner-reschedule-block',
    'planner-resolve',
    'planner-retry-operation',
    'planner-retry-all',
    'planner-sync',
  ]) {
    assert.match(host, new RegExp(`'${action}'[\\s\\S]{0,120}withPlannerStoreLock`), action);
  }
  assert.match(host, /resolveBrainRouterAccountContext\(config\)[\s\S]{0,1600}createPlannerTransport\(\{[\s\S]{0,220}token,[\s\S]{0,220}orgId/);
  assert.doesNotMatch(host, /planner(?:ListItems|ListBlocks|OutboxDetails|Add|Update|Delete|Schedule|UpdateBlock|ResolveConflict)\(undefined/);
  assert.match(host, /desktopPlannerScope\(loadConfig\(\)\)\.storeId/);
});
