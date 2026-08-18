// ADR-041 D8 — the file-writing tools. write_file is the first; it overwrites/creates
// a file through the D3 fsPort under the full write-guard stack: readOnlyGuard +
// forWrite path resolution + ownership check + read-before-overwrite + the
// silent-child approval gate + the inherited-execution-authority assertion + an
// undo snapshot. Body is the former case body verbatim (`this.x` -> `ctx.host.x`).
// edit_file joins it (same host members, targeted in-place replace); notebook_edit / apply_patch follow.

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

  edit_file: async ({ args, host, resolveHere, readOnlyGuard, fsPort }) => {
        readOnlyGuard(args.path);
        const resolved = resolveHere(args.path);
        const ownErr = ownershipWriteViolation(host.ownership, host.workspaceRoot, resolved);
        if (ownErr) throw new Error(ownErr);
        if (!(await fsPort.exists(resolved))) {
          throw new Error(`File not found: ${args.path}`);
        }
        // CC-P6.4 — read-before-edit. Editing a file the agent hasn't read this
        // session risks clobbering content it can't see (stale assumptions,
        // mismatched indentation). Require a read_file first.
        if (!host.filesReadThisSession.has(resolved)) {
          throw new Error(`Read-before-edit: you must read_file("${args.path}") before editing it — you have not read this file this session. Read it first, then edit with targetContent that matches the current contents.`);
        }
        const content = await fsPort.readFile(resolved);
        const target = args.targetContent;
        const replacement = args.replacementContent;

        const occurrences = content.split(target).length - 1;
        if (occurrences === 0) {
          throw new Error(`Target content not found in ${args.path}. Ensure targetContent matches exact indentation and newlines.`);
        }
        if (occurrences > 1) {
          throw new Error(`Target content found ${occurrences} times in ${args.path}. Specify more surrounding context to target uniquely.`);
        }

        // Use a replacer FUNCTION so `replacement` is inserted verbatim. A string
        // second arg makes String.replace interpret `$&`, `$1`, `$$`, `` $` ``, `$'`
        // as special patterns, silently corrupting any edit whose replacement text
        // contains a `$` (regex source, shell vars, template literals, prices…).
        const updated = content.replace(target, () => replacement);
        const parentDenial = await host.confirmSilentChildToolApproval({
          tool: 'edit_file',
          path: String(args.path ?? ''),
          summary: `replace ${String(target ?? '').length} chars with ${String(replacement ?? '').length} chars`,
          reason: 'silent child agent requested a file edit',
        });
        if (parentDenial) return parentDenial;
        host.assertInheritedExecutionAuthorityCurrent();
        host.captureFileSnapshot(resolved); // 0.4.x-3b — undo log for /rewind --files
        await fsPort.writeFile(resolved, updated);
        const editNotice = runPostEditCheck({ template: getCliKnobs().postEditCheck, file: resolved, cwd: host.workspaceRoot });
        const editReindex = await host.maybeReindexSource(resolved, updated);
        return `Successfully edited ${args.path}` + editNotice + editReindex;
  },
};
