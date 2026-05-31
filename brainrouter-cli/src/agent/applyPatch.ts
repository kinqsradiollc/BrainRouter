import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspacePath } from './workspaceFs.js';
import { ownershipWriteViolation } from '../orchestration/ownership.js';

/**
 * REFAC-APPLY-PATCH-MODULE (0.4.6) — the `apply_patch` envelope parser +
 * applier, extracted verbatim from `agent.ts` into its own module so the patch
 * concern is isolated (and so the 0.4.7 CODEX-APPLY-PATCH-HARDEN work — atomic
 * prevalidation + a fuller parser — has a clean home). No behavior change.
 *
 * Parses the Codex-style `*** Begin Patch` / `*** End Patch` envelope with
 * Add / Update / Delete File operations and applies them to the filesystem,
 * validating every op against the ownership boundary up front so a multi-file
 * patch never partially applies before hitting a violation.
 */
export function applyPatchEnvelope(patch: string, workspaceRoot?: string, ownership?: string | null): string {
  const text = patch.replace(/\r\n/g, '\n').trim();
  if (!text.startsWith('*** Begin Patch')) {
    throw new Error('apply_patch: missing "*** Begin Patch" header.');
  }
  if (!text.endsWith('*** End Patch')) {
    throw new Error('apply_patch: missing "*** End Patch" footer.');
  }
  const inner = text.slice('*** Begin Patch'.length, text.length - '*** End Patch'.length);
  const lines = inner.split('\n');

  type Op =
    | { kind: 'update'; file: string; oldBlock: string; newBlock: string }
    | { kind: 'add'; file: string; body: string }
    | { kind: 'delete'; file: string };

  const ops: Op[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('*** Update File: ')) {
      const file = line.slice('*** Update File: '.length).trim();
      i++;
      // Optional @@ anchor (single line for now).
      if (i < lines.length && lines[i].startsWith('@@')) {
        i++;
      }
      const oldLines: string[] = [];
      const newLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        const l = lines[i];
        if (l.startsWith('-')) {
          oldLines.push(l.slice(1));
        } else if (l.startsWith('+')) {
          newLines.push(l.slice(1));
        } else if (l.startsWith(' ')) {
          oldLines.push(l.slice(1));
          newLines.push(l.slice(1));
        } else if (l === '') {
          // tolerate blank lines as untouched
          oldLines.push('');
          newLines.push('');
        } else {
          throw new Error(`apply_patch: unexpected line in Update File "${file}": ${JSON.stringify(l)}`);
        }
        i++;
      }
      ops.push({ kind: 'update', file, oldBlock: oldLines.join('\n'), newBlock: newLines.join('\n') });
    } else if (line.startsWith('*** Add File: ')) {
      const file = line.slice('*** Add File: '.length).trim();
      i++;
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        const l = lines[i];
        if (l.startsWith('+')) body.push(l.slice(1));
        else if (l === '') body.push('');
        else throw new Error(`apply_patch: Add File "${file}" lines must start with '+': ${JSON.stringify(l)}`);
        i++;
      }
      ops.push({ kind: 'add', file, body: body.join('\n') });
    } else if (line.startsWith('*** Delete File: ')) {
      const file = line.slice('*** Delete File: '.length).trim();
      ops.push({ kind: 'delete', file });
      i++;
    } else if (line === '' || line.startsWith('***')) {
      i++;
    } else {
      throw new Error(`apply_patch: expected an operation header, got ${JSON.stringify(line)}`);
    }
  }

  const applied: Array<{ kind: string; file: string }> = [];
  const wsRoot = workspaceRoot ?? fs.realpathSync(process.cwd());
  // MAS-P3: validate EVERY op against the ownership boundary up front, so a
  // multi-file patch never partially applies before hitting a violation.
  if (ownership) {
    for (const op of ops) {
      const resolved = resolveWorkspacePath(wsRoot, op.file, { forWrite: op.kind !== 'delete' });
      const ownErr = ownershipWriteViolation(ownership, wsRoot, resolved);
      if (ownErr) throw new Error(`apply_patch: ${ownErr}`);
    }
  }
  for (const op of ops) {
    const resolved = resolveWorkspacePath(wsRoot, op.file, { forWrite: op.kind !== 'delete' });
    if (op.kind === 'add') {
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(resolved)) {
        throw new Error(`apply_patch: Add File "${op.file}" already exists. Use Update File instead.`);
      }
      fs.writeFileSync(resolved, op.body, 'utf8');
      applied.push({ kind: 'add', file: op.file });
    } else if (op.kind === 'delete') {
      if (!fs.existsSync(resolved)) {
        throw new Error(`apply_patch: Delete File "${op.file}" does not exist.`);
      }
      fs.unlinkSync(resolved);
      applied.push({ kind: 'delete', file: op.file });
    } else {
      if (!fs.existsSync(resolved)) {
        throw new Error(`apply_patch: Update File "${op.file}" does not exist.`);
      }
      const content = fs.readFileSync(resolved, 'utf8');
      const count = op.oldBlock === '' ? 0 : content.split(op.oldBlock).length - 1;
      if (count === 0) {
        throw new Error(`apply_patch: context for Update File "${op.file}" did not match. Re-read the file and resubmit.`);
      }
      if (count > 1) {
        throw new Error(`apply_patch: context for Update File "${op.file}" matched ${count} times. Add more surrounding lines for uniqueness.`);
      }
      const updated = content.replace(op.oldBlock, op.newBlock);
      fs.writeFileSync(resolved, updated, 'utf8');
      applied.push({ kind: 'update', file: op.file });
    }
  }

  return JSON.stringify({ applied }, null, 2);
}
