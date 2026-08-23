// ADR-041 D8 Phase 5 + Phase 33 — the Track (Jira-class PM) tools. track_query (read)
// and track_update (write) both read only workspaceRoot + sessionKey off the host, so
// this module adds no BuiltinToolHost surface; the trackStore functions carry every
// capability and now import here rather than runtime.ts. Bodies are the former switch
// cases verbatim (this.x -> ctx.host.x).

import {
  ensureProject as trackEnsureProject,
  getProject as trackGetProject,
  listWorkItems as trackListWorkItems,
  getWorkItem as trackGetWorkItem,
  createWorkItem as trackCreateWorkItem,
  transitionWorkItem as trackTransitionWorkItem,
  updateWorkItem as trackUpdateWorkItem,
  addComment as trackAddComment,
  linkWorkItem as trackLinkWorkItem,
  createSprint as trackCreateSprint,
  listSprints as trackListSprints,
  setSprintState as trackSetSprintState,
  updateSprint as trackUpdateSprint,
  sprintVelocity as trackSprintVelocity,
} from '../../../track/trackStore.js';
import { parseTrackQuery } from '../../../track/query/index.js';
import { isWorkItemType, isWorkItemPriority } from '@kinqs/brainrouter-types';
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

  track_update: async ({ args, host }) => {
        const action = String(args.action ?? '');
        if (action === 'create') {
          const item = trackCreateWorkItem(host.workspaceRoot, {
            title: String(args.title ?? 'Untitled'),
            type: isWorkItemType(args.type) ? args.type : 'task',
            status: typeof args.status === 'string' ? args.status : undefined,
            priority: isWorkItemPriority(args.priority) ? args.priority : undefined,
            sessionKey: host.sessionKey, actor: 'agent',
          });
          return `Created ${item.key} [${item.status}]: ${item.title}`;
        }
        if (action === 'transition') {
          try {
            const item = trackTransitionWorkItem(host.workspaceRoot, String(args.key ?? ''), String(args.toStatus ?? ''), 'agent');
            return item ? `${item.key} → ${item.status}` : `No work item "${args.key}".`;
          } catch (e) { return (e as Error).message; }
        }
        if (action === 'comment') {
          const item = trackAddComment(host.workspaceRoot, String(args.key ?? ''), 'agent', String(args.body ?? ''));
          return item ? `Commented on ${item.key}.` : `No work item "${args.key}".`;
        }
        if (action === 'link') {
          const item = trackLinkWorkItem(host.workspaceRoot, String(args.key ?? ''), {
            codeLinks: Array.isArray(args.codeLinks) ? (args.codeLinks as Array<{ kind: 'branch' | 'commit' | 'pull-request' | 'file'; ref: string }>) : undefined,
            linkedMemoryIds: Array.isArray(args.linkedMemoryIds) ? (args.linkedMemoryIds as string[]) : undefined,
            links: typeof args.blocks === 'string' ? [{ type: 'blocks', targetId: args.blocks }] : undefined,
          });
          return item ? `Linked ${item.key}.` : `No work item "${args.key}".`;
        }
        if (action === 'assign-sprint') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(host.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          const item = trackUpdateWorkItem(host.workspaceRoot, String(args.key ?? ''), { sprintId }, 'agent');
          return item ? `Assigned ${item.key} to ${sprint.name}.` : `No work item "${args.key}".`;
        }
        if (action === 'sprint-create') {
          const name = String(args.name ?? '').trim();
          if (!name) return 'sprint-create requires a name.';
          const sprint = trackCreateSprint(host.workspaceRoot, {
            name,
            goal: typeof args.goal === 'string' ? args.goal : undefined,
          });
          return `Created ${sprint.name} (${sprint.id}).`;
        }
        if (action === 'batch-transition') {
          const query = String(args.query ?? '').trim();
          if (!query) return 'batch-transition requires a query.';
          const parsed = parseTrackQuery(query);
          if (!parsed.ok) return `Bad query: ${parsed.error}`;
          const toStatus = String(args.toStatus ?? '');
          const project = trackGetProject(host.workspaceRoot) ?? trackEnsureProject(host.workspaceRoot);
          if (!project.workflowStates.some((state) => state.id === toStatus)) {
            return `Unknown workflow state "${toStatus}". Valid: ${project.workflowStates.map((state) => state.id).join(', ')}`;
          }
          const items = trackListWorkItems(host.workspaceRoot, { query }).filter((item) => item.status !== toStatus);
          for (const item of items) trackTransitionWorkItem(host.workspaceRoot, item.key, toStatus, 'agent');
          return `Transitioned ${items.length} work item${items.length === 1 ? '' : 's'} to ${toStatus}.`;
        }
        if (action === 'sprint-start') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(host.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          if (args.capacity !== undefined && (typeof args.capacity !== 'number' || !Number.isFinite(args.capacity) || args.capacity < 0)) {
            return 'Sprint capacity must be a non-negative number.';
          }
          try {
            trackSetSprintState(host.workspaceRoot, sprintId, 'active');
          } catch (error) {
            return (error as Error).message;
          }
          const updated = trackUpdateSprint(host.workspaceRoot, sprintId, {
            startDate: sprint.startDate ?? new Date().toISOString(),
            ...(typeof args.capacity === 'number' ? { capacity: args.capacity } : {}),
          })!;
          return `Started ${updated.name}.`;
        }
        if (action === 'sprint-complete') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(host.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          const velocity = trackSprintVelocity(host.workspaceRoot, sprintId)!;
          trackUpdateSprint(host.workspaceRoot, sprintId, { velocity });
          trackSetSprintState(host.workspaceRoot, sprintId, 'completed');
          return `Completed ${sprint.name} (velocity: ${velocity}).`;
        }
        return `Unknown track_update action "${action}". Use create · transition · comment · link · sprint-create · assign-sprint · batch-transition · sprint-start · sprint-complete.`;
  },
};
