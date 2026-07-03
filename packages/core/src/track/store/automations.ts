/**
 * TRACK store — automation rules.
 *
 * Declarative "when trigger [+ condition] → actions" rules and the engine that
 * runs them. Rule actions mutate the item DIRECTLY (never through the public
 * work-item mutators), so a rule can never re-trigger automation — no loops.
 */
import type {
  TrackProject,
  WorkItem,
  AutomationRule,
  AutomationTrigger,
  AutomationAction,
} from '@kinqs/brainrouter-types';
import {
  readTrack,
  writeTrack,
  shortId,
  nowIso,
  categoryOf,
  registerLabel,
  normalizeAssignees,
} from './_internal.js';
import { ensureProject } from './project.js';
import { matchesTrackQuery } from '../query/query.js';
import type { CreateAutomationInput, AutomationPatch } from './types.js';

export function listAutomations(workspaceRoot: string): AutomationRule[] {
  return Object.values(readTrack(workspaceRoot).automations).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export function createAutomation(workspaceRoot: string, input: CreateAutomationInput): AutomationRule {
  ensureProject(workspaceRoot);
  const store = readTrack(workspaceRoot);
  const ts = nowIso();
  const rule: AutomationRule = {
    id: shortId('auto'), name: input.name, enabled: input.enabled ?? true,
    trigger: input.trigger, condition: input.condition, actions: input.actions, createdAt: ts, updatedAt: ts,
  };
  store.automations[rule.id] = rule;
  writeTrack(workspaceRoot, store);
  return rule;
}

export function updateAutomation(workspaceRoot: string, id: string, patch: AutomationPatch): AutomationRule | undefined {
  const store = readTrack(workspaceRoot);
  const rule = store.automations[id];
  if (!rule) return undefined;
  Object.assign(rule, patch);
  rule.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return rule;
}

export function deleteAutomation(workspaceRoot: string, id: string): boolean {
  const store = readTrack(workspaceRoot);
  if (!store.automations[id]) return false;
  delete store.automations[id];
  writeTrack(workspaceRoot, store);
  return true;
}

/** Apply one action to an item in place; returns a short activity description, or null on no-op. */
function applyAutomationAction(project: TrackProject, item: WorkItem, action: AutomationAction): string | null {
  switch (action.type) {
    case 'set-status':
      if (!project.workflowStates.some((s) => s.id === action.value) || item.status === action.value) return null;
      item.status = action.value; item.statusCategory = categoryOf(project, action.value);
      return `status → ${action.value}`;
    case 'set-priority':
      if (item.priority === (action.value as WorkItem['priority'])) return null;
      item.priority = action.value as WorkItem['priority'];
      return `priority → ${action.value}`;
    case 'set-assignee': {
      const next = normalizeAssignees(action.value ? action.value.split(',') : []);
      if (next.join(',') === item.assignees.join(',')) return null;
      item.assignees = next; item.assignee = next[0];
      return `assignee → ${next.join(', ') || 'none'}`;
    }
    case 'add-label':
      if (item.labels.includes(action.value)) return null;
      registerLabel(project, action.value);
      item.labels = [...item.labels, action.value];
      return `+label ${action.value}`;
    case 'comment':
      item.comments = [...item.comments, { id: shortId('cmt'), author: 'automation', body: action.value, createdAt: nowIso() }];
      return 'commented';
    default:
      return null;
  }
}

/**
 * Run enabled rules for an item that just hit `trigger`. Actions are applied
 * DIRECTLY (not through the public mutation fns), so a rule can never re-trigger
 * automation — no loops. Persists once if anything changed.
 */
export function runAutomations(workspaceRoot: string, idOrKey: string, trigger: AutomationTrigger): void {
  const store = readTrack(workspaceRoot);
  const project = store.project;
  if (!project) return;
  const item = store.workItems[idOrKey] ?? Object.values(store.workItems).find((w) => w.key === idOrKey);
  if (!item) return;
  let changed = false;
  for (const rule of Object.values(store.automations)) {
    if (!rule.enabled || rule.trigger !== trigger) continue;
    if (rule.condition && rule.condition.trim() && !matchesTrackQuery(item, rule.condition)) continue;
    for (const action of rule.actions) {
      const desc = applyAutomationAction(project, item, action);
      if (desc) { item.activity.push({ at: nowIso(), actor: `automation:${rule.name}`, field: 'automation', to: desc }); changed = true; }
    }
  }
  if (changed) { item.updatedAt = nowIso(); writeTrack(workspaceRoot, store); }
}
