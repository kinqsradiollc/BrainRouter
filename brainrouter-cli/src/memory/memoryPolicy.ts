import path from 'node:path';
import type { RecalledRecord } from './briefing.js';

export interface MemoryPolicyContext {
  workspaceRoot: string;
}

const STALE_RE = /\b(stale|superseded|archived|deprecated|needs[_\s-]?verification|outdated)\b/i;
const SECRET_RE = /(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----|xox[abprs]-[A-Za-z0-9-]{10,})/;

/**
 * Local CLI memory policy. Pure functions over recall results / capture
 * payloads — no hookify dependency, no enterprise settings. Returns a list
 * of human-readable warnings that the briefing inspector surfaces, and a
 * gate for capture that can block obvious secret material.
 */

export function assessRecallCards(
  records: RecalledRecord[],
  ctx: MemoryPolicyContext,
): string[] {
  if (records.length === 0) return [];
  const warnings: string[] = [];
  let staleCount = 0;
  let offWorkspaceCount = 0;
  const wsRoot = normalizeRoot(ctx.workspaceRoot);

  for (const rec of records) {
    const content = rec.content ?? '';
    if (STALE_RE.test(content) || STALE_RE.test(rec.type ?? '')) staleCount++;
    const paths = extractPaths(content);
    for (const p of paths) {
      if (isOffWorkspacePath(p, wsRoot)) {
        offWorkspaceCount++;
        break;
      }
    }
  }

  if (staleCount > 0) {
    warnings.push(
      `recall: ${staleCount} record(s) tagged stale/superseded/needs_verification — confirm before relying on them`,
    );
  }
  if (offWorkspaceCount > 0) {
    warnings.push(
      `recall: ${offWorkspaceCount} record(s) reference paths outside ${path.basename(wsRoot)} — may be from a different workspace`,
    );
  }
  return warnings;
}

export interface CapturePolicyResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Capture-side gate. Returns `blocked: true` when the payload contains
 * obvious credential material the redactor missed (long-form keys, PEM
 * blocks, Slack tokens). Callers should drop the capture and surface the
 * reason; we deliberately do not auto-redact here — if the user is staring
 * at a key in their prompt we want the capture refused, not silently
 * laundered into memory.
 */
export function assessCapturePayload(text: string): CapturePolicyResult {
  if (!text) return { blocked: false };
  const match = text.match(SECRET_RE);
  if (match) {
    return {
      blocked: true,
      reason: `capture blocked: payload contains a credential-shaped token (${match[0].slice(0, 6)}…)`,
    };
  }
  return { blocked: false };
}

function normalizeRoot(root: string): string {
  try {
    return path.resolve(root);
  } catch {
    return root;
  }
}

function extractPaths(text: string): string[] {
  return text.match(/(?:[A-Za-z]:)?(?:[\/\\][\w.-]+){2,}/g) ?? [];
}

function isOffWorkspacePath(candidate: string, wsRoot: string): boolean {
  if (!candidate.startsWith('/') && !/^[A-Za-z]:[\/\\]/.test(candidate)) return false;
  const resolved = path.resolve(candidate);
  const rel = path.relative(wsRoot, resolved);
  return rel.startsWith('..');
}
