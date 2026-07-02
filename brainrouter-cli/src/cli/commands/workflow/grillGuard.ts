/**
 * `/grill-me` guard logic, split out of the original workflow/index.ts god
 * file (behavior-preserving). Exported for unit tests.
 */

import { ARTIFACT, artifactRelativePath, getCurrentWorkflow, readArtifact } from '@kinqs/brainrouter-core/workflow';

/**
 * Decide whether `/grill-me` should refuse to fire because the current
 * workflow already has a written `spec.md`. The clarifying pass is meant to
 * happen BEFORE the spec is committed — once a spec exists, asking again
 * usually means we're re-litigating answers the user already gave, which
 * wastes a turn. `--force` is the explicit escape hatch when the user
 * genuinely wants a second clarifying pass (e.g., scope has drifted).
 *
 * Exported helper for unit tests so the guard logic can be exercised
 * without standing up the whole REPL context. NOT pure: reads workflow
 * state from disk (`getCurrentWorkflow`, `readArtifact`) and the latter
 * may mkdirSync the workflow folder as a side effect.
 */
export function shouldSkipGrillMe(
  workspaceRoot: string,
  force: boolean,
  sessionKey?: string,
): { skip: boolean; slug?: string; specPath?: string } {
  if (force) return { skip: false };
  // 9d-bugfix: scope the "is there an active workflow?" check to THIS
  // session, not the workspace pointer. A fresh CLI with no session
  // binding should not be told "plan already exists" just because a
  // previous CLI ran `/spec` here.
  const slug = getCurrentWorkflow(workspaceRoot, sessionKey);
  if (!slug) return { skip: false };
  const spec = readArtifact(workspaceRoot, slug, ARTIFACT.spec);
  if (!spec) return { skip: false };
  return {
    skip: true,
    slug,
    specPath: artifactRelativePath(workspaceRoot, slug, ARTIFACT.spec),
  };
}
