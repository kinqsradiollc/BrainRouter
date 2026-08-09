/**
 * ADR-033 D3 — the non-interactive reviewer may ASK for a file.
 *
 * The bot was never blind: the repository is checked out at the exact SHA and a
 * deterministic assembler decides what of it becomes the evidence block. What
 * it could not do was ask for ONE more file — so a finding that turned on a
 * definition the assembler did not predict was an inference about code the
 * model never saw.
 *
 * This is the protocol for that ask, and it is deliberately small: the model
 * emits a request block instead of a findings block, the caller serves the
 * files it is allowed to serve, and the review continues in a second round. The
 * deterministic packet STAYS as the floor — a reviewer that had to fetch
 * everything itself would be slower and less predictable than one that starts
 * with the right evidence in hand.
 *
 * Every served file is still untrusted evidence, and a path we will not serve
 * comes back labelled rather than silently missing: a reviewer that cannot tell
 * "not there" from "not allowed" will guess, which is what the grounding
 * vocabulary exists to prevent.
 */

/** Ceiling on one round's ask — a reviewer, not a crawler. */
export const MAX_EVIDENCE_REQUEST_FILES = 6;

/** How many extra rounds a review may spend asking. One is enough to check. */
export const MAX_EVIDENCE_REQUEST_ROUNDS = 1;

/** The instruction that licenses the ask, appended after a lens contract. */
export function buildEvidenceRequestContract(maxFiles = MAX_EVIDENCE_REQUEST_FILES): string {
  return (
    `If a finding depends on a file you were NOT shown, do not guess it and do not drop it: reply with ONLY a fenced \`\`\`json block of the form {"request_files": ["repo/relative/path.ts"]} — at most ${maxFiles} paths, repo-relative, no globs — and nothing else. ` +
    'You will be shown those files and asked again. You get one such round, so ask for everything you need at once, and ask only for what would change a finding.'
  );
}

/**
 * Parse a reply that may be a file request. Returns null when the reply is an
 * ordinary review (the overwhelmingly common case), so the caller can treat a
 * request as the exception it is.
 */
export function parseEvidenceRequest(text: string, maxFiles = MAX_EVIDENCE_REQUEST_FILES): string[] | null {
  const raw = String(text ?? '');
  if (!raw.includes('request_files')) return null;
  const blocks: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(raw)) !== null) blocks.push(match[1].trim());
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) blocks.push(raw.slice(start, end + 1));

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const requested = (parsed as { request_files?: unknown }).request_files;
    if (!Array.isArray(requested)) continue;
    const paths = requested
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= 400)
      .slice(0, maxFiles);
    if (paths.length > 0) return [...new Set(paths)];
  }
  return null;
}

/** One answer to a requested path: the content, or why it is not being served. */
export interface ServedEvidenceFile {
  path: string;
  content?: string;
  /** Set when the path was refused or missing — never left implicit. */
  unavailableReason?: string;
}

/**
 * Render served files as an evidence block. Line numbers are included because
 * the reviewer is about to be asked for a position, and reading one off a
 * numbered listing is cheaper and more accurate than counting.
 */
export function formatServedEvidence(files: readonly ServedEvidenceFile[]): string {
  if (files.length === 0) return 'No requested file could be served.';
  return files
    .map((file) => {
      if (typeof file.content !== 'string') {
        return `--- ${file.path} — UNAVAILABLE: ${file.unavailableReason ?? 'not served'}`;
      }
      const numbered = file.content
        .split('\n')
        .map((line, index) => `${index + 1}\t${line}`)
        .join('\n');
      return `--- ${file.path} (exact revision, line-numbered)\n${numbered}`;
    })
    .join('\n\n');
}
