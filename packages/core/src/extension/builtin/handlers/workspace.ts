// ADR-041 D8 Phase 32 — the workspace-participant tools (ADR-029 records the agent
// creates/updates/links/resolves). All four read only `workspaceRoot` off the host, so
// this module adds ZERO new BuiltinToolHost surface — the registry (buildLocalWorkspaceRegistry)
// + reference codec (parse/formatWorkspaceRef) carry every capability. Bodies are the former
// switch cases verbatim (`this.x` -> `ctx.host.x`).

import { formatWorkspaceRef, parseWorkspaceRef } from '../../../workspace/references/index.js';
import { buildLocalWorkspaceRegistry, fenceWorkspaceResolutions, linkWorkspaceRef, localWorkspaceViewer } from '../../../workspace/participants/index.js';
import type { BuiltinToolHandler } from './registry.js';

export const workspaceHandlers: Record<string, BuiltinToolHandler> = {
  workspace_resolve: async ({ args, host }) => {
        const registry = buildLocalWorkspaceRegistry({ workspaceRoot: host.workspaceRoot });
        const viewer = localWorkspaceViewer({ workspaceRoot: host.workspaceRoot });
        const resolution = await registry.resolveUri(String(args.uri ?? ''), viewer);
        // C4 — fenced and neutralised before it is a tool result. Any mode is a
        // delivery vector for every other, so the boundary is drawn where the
        // content enters the turn rather than where it was written.
        return fenceWorkspaceResolutions([resolution]) ?? 'Nothing to show for that reference.';
  },

  workspace_create: async ({ args, host }) => {
        const title = String(args.title ?? '').trim();
        if (!title) throw new Error('A title is required.');
        const registry = buildLocalWorkspaceRegistry({ workspaceRoot: host.workspaceRoot });
        const viewer = localWorkspaceViewer({ workspaceRoot: host.workspaceRoot });
        const from = typeof args.from === 'string' ? parseWorkspaceRef(args.from) : null;
        // A malformed `from` is refused rather than dropped: the caller asked
        // for the new record to remember where it came from, and silently
        // creating one that does not is the quietly-wrong outcome A3 rules out.
        if (from && !from.ok) throw new Error(`"from" is not a reference: ${from.detail}`);
        const outcome = await registry.create(
          {
            mode: String(args.mode ?? ''),
            kind: String(args.kind ?? ''),
            title,
            ...(from?.ok ? { from: from.ref } : {}),
            // ADR-029 Part E — the fields a created record arrives WITH. A
            // database row created without its cells needs a second call to
            // become what was asked for, and the window between the two is a row
            // whose every column is empty.
            ...(args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
              ? { fields: args.fields as Record<string, unknown> }
              : {}),
          },
          viewer,
        );
        if (outcome.status === 'refused') throw new Error(outcome.detail);
        return JSON.stringify({ status: outcome.status, uri: formatWorkspaceRef(outcome.ref) });
  },

  workspace_update: async ({ args, host }) => {
        const target = parseWorkspaceRef(args.uri);
        if (!target.ok) throw new Error(`"uri" is not a reference: ${target.detail}`);
        const registry = buildLocalWorkspaceRegistry({ workspaceRoot: host.workspaceRoot });
        const viewer = localWorkspaceViewer({ workspaceRoot: host.workspaceRoot });
        const outcome = await registry.update(
          {
            ref: target.ref,
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            ...(args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
              ? { fields: args.fields as Record<string, unknown> }
              : {}),
          },
          viewer,
        );
        if (outcome.status === 'refused') throw new Error(outcome.detail);
        return JSON.stringify({
          status: outcome.status,
          uri: formatWorkspaceRef(outcome.ref),
          changed: outcome.changed,
          // Returned rather than dropped: a caller told only about the four
          // fields that worked concludes the fifth did too, and finds out a long
          // way from here.
          ...(outcome.ignored?.length ? { ignored: outcome.ignored } : {}),
          ...(outcome.label ? { label: outcome.label } : {}),
        });
  },

  workspace_link: async ({ args, host }) => {
        const from = parseWorkspaceRef(args.from);
        const to = parseWorkspaceRef(args.to);
        if (!from.ok) throw new Error(`"from" is not a reference: ${from.detail}`);
        if (!to.ok) throw new Error(`"to" is not a reference: ${to.detail}`);
        const outcome = linkWorkspaceRef({ workspaceRoot: host.workspaceRoot }, from.ref, to.ref);
        if (!outcome.ok) throw new Error(outcome.detail);
        return JSON.stringify({
          from: formatWorkspaceRef(outcome.from),
          to: formatWorkspaceRef(outcome.to),
          alreadyLinked: outcome.alreadyLinked,
        });
  },
};
