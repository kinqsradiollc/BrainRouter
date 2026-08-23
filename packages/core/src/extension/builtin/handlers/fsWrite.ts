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
import { applyNotebookEdit } from '../../../agent/fs/notebookEdit.js';
import fs from 'node:fs';
import { applyPatchEnvelope, assessPatchSafety, parsePatchEnvelope } from '../../../agent/fs/applyPatch.js';
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

  notebook_edit: async ({ args, host, resolveHere, readOnlyGuard, fsPort }) => {
        readOnlyGuard(args.path);
        const resolved = resolveHere(args.path);
        const ownErr = ownershipWriteViolation(host.ownership, host.workspaceRoot, resolved);
        if (ownErr) throw new Error(ownErr);
        if (!/\.ipynb$/i.test(resolved)) throw new Error('notebook_edit targets a .ipynb (Jupyter notebook) file.');
        if (!(await fsPort.exists(resolved))) throw new Error(`Notebook not found: ${args.path}`);
        const editMode = args.edit_mode === 'insert' || args.edit_mode === 'delete' ? args.edit_mode : 'replace';
        const cellIndex = args.cell_index === undefined || args.cell_index === null ? undefined : Number(args.cell_index);
        const cellType = args.cell_type === 'markdown' ? 'markdown' : args.cell_type === 'code' ? 'code' : undefined;
        const parentDenial = await host.confirmSilentChildToolApproval({
          tool: 'notebook_edit', path: String(args.path ?? ''),
          summary: `${editMode} cell ${cellIndex ?? '(append)'}`,
          reason: 'silent child agent requested a notebook edit',
        });
        if (parentDenial) return parentDenial;
        host.assertInheritedExecutionAuthorityCurrent();
        host.captureFileSnapshot(resolved); // undo log for /rewind --files
        const result = applyNotebookEdit(await fsPort.readFile(resolved), { editMode, cellIndex, cellType, source: String(args.source ?? '') });
        await fsPort.writeFile(resolved, result.content);
        host.filesReadThisSession.add(resolved);
        return JSON.stringify({ path: args.path, edit_mode: editMode, cells: result.cells });
  },

  apply_patch: async ({ args, host }) => {
        const patch = String(args.patch ?? '');
        if (!patch.trim()) throw new Error('apply_patch requires a non-empty patch.');
        const ops = parsePatchEnvelope(patch);
        const safety = assessPatchSafety(ops);
        const parentDenial = await host.confirmSilentChildToolApproval({
          tool: 'apply_patch',
          summary: `${safety.adds} add, ${safety.updates} update, ${safety.deletes} delete, ${safety.renames} rename`,
          reason: safety.touchesVcs
            ? 'silent child agent requested a patch touching VCS metadata'
            : 'silent child agent requested a patch',
          dangerous: safety.touchesVcs || safety.deletes > 0,
        });
        if (parentDenial) return parentDenial;
        host.assertInheritedExecutionAuthorityCurrent();
        // 0.4.x-3b — capture each target file's prior content before the patch
        // applies (undo log for /rewind --files). Parse the envelope's file
        // headers (`*** Add/Update/Delete File: <path>`).
        for (const m of patch.matchAll(/^\*\*\*\s+(?:Add|Update|Delete) File:\s*(.+)\s*$/gm)) {
          const p = m[1].trim();
          if (p) { try { host.captureFileSnapshot(path.resolve(host.workspaceRoot, p)); } catch { /* noop */ } }
        }
        {
          const result = applyPatchEnvelope(patch, host.workspaceRoot, host.ownership);
          const firstFile = patch.match(/^\*\*\*\s+(?:Add|Update) File:\s*(.+)\s*$/m)?.[1]?.trim();
          const checkFile = firstFile ? path.resolve(host.workspaceRoot, firstFile) : host.workspaceRoot;
          const patchNotice = runPostEditCheck({ template: getCliKnobs().postEditCheck, file: checkFile, cwd: host.workspaceRoot });
          let patchReindex = '';
          if (firstFile) {
            try { patchReindex = await host.maybeReindexSource(checkFile, fs.readFileSync(checkFile, 'utf8')); } catch { /* file may have been deleted */ }
          }
          return result + patchNotice + patchReindex;
        }
  },
};
