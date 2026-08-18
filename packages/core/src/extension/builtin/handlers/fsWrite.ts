// ADR-041 D8 — the file-writing tools. write_file is the first; it overwrites/creates
// a file through the D3 fsPort under the full write-guard stack: readOnlyGuard +
// forWrite path resolution + ownership check + read-before-overwrite + the
// silent-child approval gate + the inherited-execution-authority assertion + an
// undo snapshot. Body is the former case body verbatim (`this.x` -> `ctx.host.x`).
// edit_file / notebook_edit / apply_patch reuse the same host members and follow.

import path from 'node:path';
import { ownershipWriteViolation } from '../../../orchestration/ownership/ownership.js';
import { runPostEditCheck } from '../../../util/agentloop/postEditCheck.js';
import { getCliKnobs } from '../../../config/config.js';
import type { BuiltinToolHandler } from './registry.js';

export const fsWriteHandlers: Record<string, BuiltinToolHandler> = {
  write_file: async ({ args, host, resolveHere, readOnlyGuard, fsPort }) => {
        readOnlyGuard(args.path);
        const resolved = resolveHere(args.path, { forWrite: true });
        const ownErr = ownershipWriteViolation(host.ownership, host.workspaceRoot, resolved);
        if (ownErr) throw new Error(ownErr);
        // CC-P6.4 — read-before-overwrite. Creating a NEW file is fine, but
        // overwriting an EXISTING one the agent hasn't read this session would
        // blow away content it never saw. Require a read_file first in that case.
        if ((await fsPort.exists(resolved)) && !host.filesReadThisSession.has(resolved)) {
          throw new Error(`Read-before-overwrite: "${args.path}" already exists and you have not read it this session. read_file("${args.path}") first (then write_file replaces it intentionally), or use edit_file for a targeted change.`);
        }
        const parentDenial = await host.confirmSilentChildToolApproval({
          tool: 'write_file',
          path: String(args.path ?? ''),
          summary: `write ${String(args.content ?? '').length} chars`,
          reason: 'silent child agent requested a file write',
        });
        if (parentDenial) return parentDenial;
        host.assertInheritedExecutionAuthorityCurrent();
        // A successful overwrite means the on-disk content is now what the agent
        // wrote — keep the read ledger accurate so a follow-up edit is allowed.
        host.filesReadThisSession.add(resolved);
        host.captureFileSnapshot(resolved); // 0.4.x-3b — undo log for /rewind --files
        const dir = path.dirname(resolved);
        if (!(await fsPort.exists(dir))) {
          await fsPort.mkdirp(dir);
        }
        await fsPort.writeFile(resolved, args.content);
        const writeNotice = runPostEditCheck({ template: getCliKnobs().postEditCheck, file: resolved, cwd: host.workspaceRoot });
        const reindexNotice = await host.maybeReindexSource(resolved, args.content);
        return `Successfully wrote file: ${args.path}` + writeNotice + reindexNotice;  },
};
