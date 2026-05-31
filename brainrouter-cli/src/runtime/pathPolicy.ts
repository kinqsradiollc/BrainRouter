import fs from 'node:fs';
import path from 'node:path';

/**
 * MEM-36 (0.4.4) — declarative path validation for tool boundaries. A single
 * realpath-aware containment check so file tools can refuse paths that escape
 * the allowed roots (`..` traversal, absolute paths, or symlinks that point
 * outside). Consolidates the ad-hoc `isInside` / realpath logic that lived in
 * the orchestration layer, and is the primitive POLICY-3's external-directory
 * gate builds on.
 */

/** Resolve a path to its realpath, falling back to the realpath of the nearest
 * existing ancestor + the unresolved tail. This makes containment checks robust
 * for not-yet-created files (write targets) while still resolving symlinks in
 * the part of the path that exists. */
export function realResolve(target: string): string {
  const abs = path.resolve(target);
  let dir = abs;
  const tail: string[] = [];
  // Walk up to the first existing ancestor.
  // Bounded by the filesystem depth; the loop terminates at the root.
  for (;;) {
    try {
      const real = fs.realpathSync(dir);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs; // reached root with nothing existing
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

/** True when `child` is `parent` itself or nested beneath it (no `..` escape). */
export function isInsideRoot(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * True when `target` (after realpath resolution) is inside ANY of `roots`
 * (each also realpath-resolved). An empty roots list denies everything.
 */
export function isPathWithinRoots(target: string, roots: string[]): boolean {
  if (!roots || roots.length === 0) return false;
  const real = realResolve(target);
  for (const root of roots) {
    if (isInsideRoot(realResolve(root), real)) return true;
  }
  return false;
}

export class PathPolicyError extends Error {
  readonly target: string;
  readonly roots: string[];
  constructor(target: string, roots: string[], label?: string) {
    super(
      `${label ?? 'path'} "${target}" is outside the allowed root${roots.length === 1 ? '' : 's'} (${roots.join(', ') || 'none'})`,
    );
    this.name = 'PathPolicyError';
    this.target = target;
    this.roots = roots;
  }
}

/** Throw `PathPolicyError` unless `target` resolves inside one of `roots`. Returns the realpath. */
export function assertPathWithinRoots(target: string, roots: string[], label?: string): string {
  if (!isPathWithinRoots(target, roots)) throw new PathPolicyError(target, roots, label);
  return realResolve(target);
}
