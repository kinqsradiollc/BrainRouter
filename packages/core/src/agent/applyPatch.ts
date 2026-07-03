import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspacePath } from './workspaceFs.js';
import { ownershipWriteViolation } from '../orchestration/ownership/ownership.js';

/**
 * `apply_patch` envelope parser + applier.
 *
 * CODEX-APPLY-PATCH-HARDEN (0.4.7): hardened from the original
 * parse-and-write-as-you-go applier (REFAC-APPLY-PATCH-MODULE, 0.4.6) to a
 * **two-phase, fully atomic** model — *prevalidate every op, then flush*. The
 * old applier checked each op's precondition (Add-target-absent /
 * Delete-target-present / Update-context-unique) *during* the write loop, so a
 * later failure could leave earlier ops already written to disk. Now every
 * precondition is checked against an evolving **in-memory** model first; the
 * filesystem is only touched once the entire patch is known to apply cleanly.
 *
 * Parser covers the Codex-style envelope: `*** Begin/End Patch`,
 * `*** Add/Update/Delete File:`, optional `@@` anchors, an optional
 * `*** Move to:` rename on an Update, and tolerates `*** End of File` markers.
 */

type Op =
  | { kind: 'update'; file: string; moveTo: string | null; oldBlock: string; newBlock: string }
  | { kind: 'add'; file: string; body: string }
  | { kind: 'delete'; file: string };

/** Parse the envelope into ops. Pure — no filesystem access. */
export function parsePatchEnvelope(patch: string): Op[] {
  const text = patch.replace(/\r\n/g, '\n').trim();
  if (!text.startsWith('*** Begin Patch')) {
    throw new Error('apply_patch: missing "*** Begin Patch" header.');
  }
  if (!text.endsWith('*** End Patch')) {
    throw new Error('apply_patch: missing "*** End Patch" footer.');
  }
  const inner = text.slice('*** Begin Patch'.length, text.length - '*** End Patch'.length);
  const lines = inner.split('\n');

  const ops: Op[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('*** Update File: ')) {
      const file = line.slice('*** Update File: '.length).trim();
      i++;
      // Optional `*** Move to:` rename directive (Codex move marker).
      let moveTo: string | null = null;
      if (i < lines.length && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
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
      ops.push({ kind: 'update', file, moveTo, oldBlock: oldLines.join('\n'), newBlock: newLines.join('\n') });
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
      // Blank lines and non-op markers (e.g. `*** End of File`) are skipped.
      i++;
    } else {
      throw new Error(`apply_patch: expected an operation header, got ${JSON.stringify(line)}`);
    }
  }
  return ops;
}

export interface PatchSafety {
  adds: number;
  updates: number;
  deletes: number;
  renames: number;
  /** True when any op targets a path under `.git/` — surfaced for approval routing. */
  touchesVcs: boolean;
}

/** Pure — summarise what a patch will do, for display / approval routing. */
export function assessPatchSafety(ops: Op[]): PatchSafety {
  const isVcs = (p: string) => /(^|\/)\.git(\/|$)/.test(p);
  let renames = 0;
  let touchesVcs = false;
  for (const op of ops) {
    if (isVcs(op.file)) touchesVcs = true;
    if (op.kind === 'update' && op.moveTo) {
      renames++;
      if (isVcs(op.moveTo)) touchesVcs = true;
    }
  }
  return {
    adds: ops.filter((o) => o.kind === 'add').length,
    updates: ops.filter((o) => o.kind === 'update').length,
    deletes: ops.filter((o) => o.kind === 'delete').length,
    renames,
    touchesVcs,
  };
}

/** A concrete filesystem mutation, computed during prevalidation, flushed after. */
type PlannedWrite =
  | { action: 'write'; path: string; content: string }
  | { action: 'delete'; path: string }
  | { action: 'rename'; from: string; to: string; content: string };

export function applyPatchEnvelope(patch: string, workspaceRoot?: string, ownership?: string | null): string {
  const ops = parsePatchEnvelope(patch);
  const wsRoot = workspaceRoot ?? fs.realpathSync(process.cwd());

  // ---- Phase 1: PREVALIDATE everything (no disk writes) -------------------
  // MAS-P3: ownership boundary up front.
  if (ownership) {
    for (const op of ops) {
      const resolved = resolveWorkspacePath(wsRoot, op.file, { forWrite: op.kind !== 'delete' });
      const ownErr = ownershipWriteViolation(ownership, wsRoot, resolved);
      if (ownErr) throw new Error(`apply_patch: ${ownErr}`);
      if (op.kind === 'update' && op.moveTo) {
        const movedResolved = resolveWorkspacePath(wsRoot, op.moveTo, { forWrite: true });
        const moveErr = ownershipWriteViolation(ownership, wsRoot, movedResolved);
        if (moveErr) throw new Error(`apply_patch: ${moveErr}`);
      }
    }
  }

  // In-memory model of file contents as the patch progresses, so a later op
  // sees earlier ops' effects and NOTHING is written until all ops validate.
  const model = new Map<string, string | null>(); // resolved path -> content, or null = absent
  const readModel = (p: string): string | null => {
    if (model.has(p)) return model.get(p)!;
    const onDisk = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    model.set(p, onDisk);
    return onDisk;
  };

  const plan: PlannedWrite[] = [];
  const applied: Array<{ kind: string; file: string; movedTo?: string }> = [];

  for (const op of ops) {
    const resolved = resolveWorkspacePath(wsRoot, op.file, { forWrite: op.kind !== 'delete' });
    if (op.kind === 'add') {
      if (readModel(resolved) !== null) {
        throw new Error(`apply_patch: Add File "${op.file}" already exists. Use Update File instead.`);
      }
      model.set(resolved, op.body);
      plan.push({ action: 'write', path: resolved, content: op.body });
      applied.push({ kind: 'add', file: op.file });
    } else if (op.kind === 'delete') {
      if (readModel(resolved) === null) {
        throw new Error(`apply_patch: Delete File "${op.file}" does not exist.`);
      }
      model.set(resolved, null);
      plan.push({ action: 'delete', path: resolved });
      applied.push({ kind: 'delete', file: op.file });
    } else {
      const content = readModel(resolved);
      if (content === null) {
        throw new Error(`apply_patch: Update File "${op.file}" does not exist.`);
      }
      const count = op.oldBlock === '' ? 0 : content.split(op.oldBlock).length - 1;
      if (count === 0) {
        throw new Error(`apply_patch: context for Update File "${op.file}" did not match. Re-read the file and resubmit.`);
      }
      if (count > 1) {
        throw new Error(`apply_patch: context for Update File "${op.file}" matched ${count} times. Add more surrounding lines for uniqueness.`);
      }
      const updated = content.replace(op.oldBlock, op.newBlock);
      if (op.moveTo) {
        const movedResolved = resolveWorkspacePath(wsRoot, op.moveTo, { forWrite: true });
        if (movedResolved !== resolved && readModel(movedResolved) !== null) {
          throw new Error(`apply_patch: Move to "${op.moveTo}" failed — destination already exists.`);
        }
        model.set(resolved, null);
        model.set(movedResolved, updated);
        plan.push({ action: 'rename', from: resolved, to: movedResolved, content: updated });
        applied.push({ kind: 'update', file: op.file, movedTo: op.moveTo });
      } else {
        model.set(resolved, updated);
        plan.push({ action: 'write', path: resolved, content: updated });
        applied.push({ kind: 'update', file: op.file });
      }
    }
  }

  // ---- Phase 2: FLUSH (every op validated — now it's safe to touch disk) --
  for (const step of plan) {
    if (step.action === 'write') {
      const dir = path.dirname(step.path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(step.path, step.content, 'utf8');
    } else if (step.action === 'delete') {
      if (fs.existsSync(step.path)) fs.unlinkSync(step.path);
    } else {
      const dir = path.dirname(step.to);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(step.to, step.content, 'utf8');
      if (step.from !== step.to && fs.existsSync(step.from)) fs.unlinkSync(step.from);
    }
  }

  return JSON.stringify({ applied, safety: assessPatchSafety(ops) }, null, 2);
}
