// ADR-041 D8 Phase 5 — track_query (read-only). Uses only workspaceRoot (already
// on BuiltinToolHost), so it adds no host field. The track store functions stay
// imported in runtime.ts too (track_update, a DEFER write tool, still needs them),
// so this module re-imports them from the same source — no dead export. Body is
// the former case verbatim (this.workspaceRoot -> ctx.host.workspaceRoot).

import {
  ensureProject as trackEnsureProject,
  getProject as trackGetProject,
  listWorkItems as trackListWorkItems,
  getWorkItem as trackGetWorkItem,
  listSprints as trackListSprints,
  sprintVelocity as trackSprintVelocity,
} from '../../../track/trackStore.js';
import { isWorkItemType } from '@kinqs/brainrouter-types';
import type { BuiltinToolHandler } from './registry.js';

export const trackHandlers: Record<string, BuiltinToolHandler> = {
  track_query: async ({ args, host }) => {
    const action = String(args.action ?? 'list');
    if (action === 'board') {
      const project = trackGetProject(host.workspaceRoot) ?? trackEnsureProject(host.workspaceRoot);
      const items = trackListWorkItems(host.workspaceRoot);
      const columns = project.workflowStates.map((s) => ({
        state: s.name, id: s.id,
        items: items.filter((w) => w.status === s.id).map((w) => ({ key: w.key, type: w.type, title: w.title, priority: w.priority, assignee: w.assignee })),
      }));
      return JSON.stringify({ project: { key: project.key, name: project.name }, columns }, null, 2);
    }
    if (action === 'get') {
      const item = trackGetWorkItem(host.workspaceRoot, String(args.key ?? ''));
      return item ? JSON.stringify(item, null, 2) : `No work item "${args.key}".`;
    }
    if (action === 'sprints') {
      return JSON.stringify(trackListSprints(host.workspaceRoot), null, 2);
    }
    if (action === 'sprint-detail') {
      const sprintId = String(args.sprintId ?? '');
      const sprint = trackListSprints(host.workspaceRoot).find((candidate) => candidate.id === sprintId);
      if (!sprint) return `No sprint "${sprintId}".`;
      return JSON.stringify({ sprint, items: trackListWorkItems(host.workspaceRoot, { sprintId }) }, null, 2);
    }
    if (action === 'velocity') {
      const sprintId = typeof args.sprintId === 'string' ? args.sprintId : undefined;
      if (sprintId) {
        const velocity = trackSprintVelocity(host.workspaceRoot, sprintId);
        return velocity === undefined ? `No sprint "${sprintId}".` : JSON.stringify({ sprintId, velocity });
      }
      return JSON.stringify(trackListSprints(host.workspaceRoot).map((sprint) => ({
        sprintId: sprint.id,
        velocity: trackSprintVelocity(host.workspaceRoot, sprint.id) ?? 0,
      })), null, 2);
    }
    const items = trackListWorkItems(host.workspaceRoot, {
      status: typeof args.status === 'string' ? args.status : undefined,
      type: isWorkItemType(args.type) ? args.type : undefined,
      assignee: typeof args.assignee === 'string' ? args.assignee : undefined,
      text: typeof args.text === 'string' ? args.text : undefined,
    });
    return JSON.stringify(items.map((w) => ({ key: w.key, type: w.type, status: w.status, statusCategory: w.statusCategory, priority: w.priority, title: w.title, assignee: w.assignee })), null, 2);
  },
};
