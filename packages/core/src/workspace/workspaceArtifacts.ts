/**
 * The workspace artifacts the frontend capability hands the model as DATA:
 * `design.md` (ADR-031 D5 — visual truth) and, beside it, `product.md`
 * (ADR-056 D-B6 — product truth). One reader, one path precedence, one
 * neutralised-and-fenced injection; tokens stay in `design.md`, product truth
 * stays out of it (rules 09 §7c).
 *
 * ADR-031 D5 — *"`study` produces a `design.md`, and we already have a place for it."*
 *
 * D5 says the design skill's portable design document "is the same artifact the
 * pending design-artifact work for the frontend capability needs, so these
 * should be decided together rather than producing two formats for one
 * purpose". The decision was recorded and then nothing implemented it: the
 * capability's prompt block told the agent to "discover and follow the workspace
 * design artifact" with no convention for where one lives, no reader, and
 * nothing that changed when a workspace had one. This file IS the decision.
 *
 * **The format is the skill's.** `skills/design/hallmark/references/design-md.md`
 * defines what a `design.md` contains, and the skill both writes one (`study`)
 * and reads one back as the locked system on later runs. Inventing a second
 * schema here would produce exactly the two formats D5 exists to avoid, and the
 * one nobody wrote a generator for would be the one that rotted.
 *
 * **Where it lives, in order.** The project root first, because that is where
 * the skill writes it and where a person looking for it would look. Then
 * `.brainrouter/design.md` for a workspace that prefers its configuration out of
 * the way, then `docs/design.md`. First match wins; a workspace with two is not
 * an error worth failing a turn over, and searching further would make which one
 * applied depend on directory order.
 *
 * **What reaches the model is DATA, not instruction.** A design document is
 * written by whoever owns the repository, and a repository can be someone else's
 * — the same trust position ADR-029 C4 takes about note content. So the text is
 * neutralised before it is handed over and it is introduced as a description of
 * the product's design, never as a set of instructions to follow. The skill
 * takes the same position at its own layer (SKILL.md: the artifact is data).
 *
 * **Bounded.** A design document is a page or two. One that is a megabyte is
 * either generated or hostile, and either way it must not become the whole
 * system prompt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fenceMarkerPattern } from '../planner/agentContext.js';
import type { WorkspaceArtifact, WorkspaceDesignArtifact, WorkspaceProductArtifact } from './workspaceArtifactsPrompt.js';
import { asUntrustedWorkspaceText } from './participants/agentContext.js';

export {
  renderDesignArtifactBlock,
  renderProductArtifactBlock,
  renderWorkspaceArtifactsBlock,
  type WorkspaceArtifact,
  type WorkspaceDesignArtifact,
  type WorkspaceProductArtifact,
} from './workspaceArtifactsPrompt.js';

/** The paths a design artifact may live at, in the order they are consulted. */
export const DESIGN_ARTIFACT_PATHS = [
  'design.md',
  path.join('.brainrouter', 'design.md'),
  path.join('docs', 'design.md'),
] as const;

/**
 * ADR-056 D-B6 — where `product.md` may live, the same precedence as `design.md`
 * for the same reasons: beside it, or out of the way, or with the docs.
 */
export const PRODUCT_ARTIFACT_PATHS = [
  'product.md',
  path.join('.brainrouter', 'product.md'),
  path.join('docs', 'product.md'),
] as const;

/**
 * The most of a design document that reaches a turn.
 *
 * Sized against the format: `references/design-md.md` describes a document of a
 * few sections — colour, type, spacing, components, voice — which lands well
 * inside this. Past it the file is not a design document, and the turn's context
 * belongs to the task.
 */
export const MAX_DESIGN_ARTIFACT_CHARS = 24_000;

/** One line of it. A design document's lines are sentences, not paragraphs. */
const MAX_DESIGN_ARTIFACT_LINE = 600;

/**
 * This module's own fence, broken the same way every other one is.
 *
 * `asUntrustedWorkspaceText` breaks `</workspace_data>`; the block below opens a
 * different marker, and a design document that closed it from inside would put
 * everything after it back into the instruction stream.
 */
const DESIGN_FENCE = fenceMarkerPattern('design_artifact');
const PRODUCT_FENCE = fenceMarkerPattern('product_artifact');

/**
 * The first artifact found at `paths`, neutralised and bounded, or null.
 *
 * Never throws: a turn must not fail because a file it optionally reads is a
 * directory, is unreadable, or vanished between the check and the read.
 */
function readWorkspaceArtifact(workspaceRoot: string, paths: readonly string[], fence: RegExp): WorkspaceArtifact | null {
  if (!workspaceRoot) return null;
  for (const relative of paths) {
    const absolute = path.join(workspaceRoot, relative);
    let raw: string;
    try {
      if (!fs.statSync(absolute).isFile()) continue;
      raw = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    if (!raw.trim()) continue;
    const truncated = raw.length > MAX_DESIGN_ARTIFACT_CHARS;
    return {
      path: relative,
      // Neutralised PER LINE and rejoined, the way an attachment's extracted
      // text is: the shared helper collapses newlines, which is right for a
      // one-line label and wrong for a Markdown document — a design system
      // flattened to one paragraph is one nobody can follow.
      content: (truncated ? raw.slice(0, MAX_DESIGN_ARTIFACT_CHARS) : raw)
        .split('\n')
        .map((line) => asUntrustedWorkspaceText(line, MAX_DESIGN_ARTIFACT_LINE).replace(fence, '[fence]'))
        .join('\n'),
      truncated,
    };
  }
  return null;
}

/** The workspace's design artifact (`design.md`), or null when it has none. */
export function readWorkspaceDesignArtifact(workspaceRoot: string): WorkspaceDesignArtifact | null {
  return readWorkspaceArtifact(workspaceRoot, DESIGN_ARTIFACT_PATHS, DESIGN_FENCE);
}

/** ADR-056 D-B6 — the workspace's product artifact (`product.md`), or null. */
export function readWorkspaceProductArtifact(workspaceRoot: string): WorkspaceProductArtifact | null {
  return readWorkspaceArtifact(workspaceRoot, PRODUCT_ARTIFACT_PATHS, PRODUCT_FENCE);
}
