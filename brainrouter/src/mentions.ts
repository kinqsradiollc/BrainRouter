import fs from 'node:fs';
import path from 'node:path';
import { isPathInside } from './cliState.js';

/**
 * Expand `@path/to/file` mentions in a user prompt by appending the referenced
 * file contents as a fenced block, the way Claude Code and Codex do it.
 *
 * Rules:
 *   - Token shape: `@` followed by a workspace-relative path. The path can
 *     contain letters, digits, `._-/~`, but stops at whitespace or punctuation
 *     that wouldn't appear in a filename.
 *   - File must exist and resolve INSIDE the workspace (no `..` escapes).
 *   - Each file is appended only once even if mentioned multiple times.
 *   - Mention text in the prompt is left intact so the human-written sentence
 *     still makes sense; the contents are added below as a context block.
 *   - Files larger than `maxBytes` are truncated with a marker.
 *
 * Returns `{ expanded, mentions }`. `mentions` is the resolved set of files
 * actually attached, useful for status display.
 */
const MAX_BYTES_DEFAULT = 24_000;
const MENTION_RE = /(^|\s)@([\w./~-][\w./~-]*[\w/])/g;

export interface MentionExpansion {
  expanded: string;
  mentions: Array<{ token: string; resolvedPath: string; bytes: number; truncated: boolean }>;
}

export function expandMentions(
  prompt: string,
  workspaceRoot: string,
  maxBytes = MAX_BYTES_DEFAULT,
): MentionExpansion {
  // Resolve each mention to {resolvedPath, body (possibly truncated), truncated}
  // in a single pass. Re-reading inside the rendering loop with a different
  // limit would silently undo the truncation we just computed.
  const mentioned = new Map<string, { resolvedPath: string; body: string; truncated: boolean }>();
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(prompt)) !== null) {
    const token = match[2];
    if (!token || mentioned.has(token)) continue;
    let resolved: string;
    try {
      resolved = path.resolve(workspaceRoot, token);
    } catch {
      continue;
    }
    if (!isPathInside(workspaceRoot, resolved)) continue;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
    let content = fs.readFileSync(resolved, 'utf8');
    let truncated = false;
    if (content.length > maxBytes) {
      content = content.slice(0, maxBytes) + `\n…[truncated at ${maxBytes} chars]`;
      truncated = true;
    }
    mentioned.set(token, { resolvedPath: resolved, body: content, truncated });
  }

  if (mentioned.size === 0) return { expanded: prompt, mentions: [] };

  const blocks: string[] = ['', '---', 'Attached files (from @-mentions):', ''];
  for (const [token, info] of mentioned.entries()) {
    const rel = path.relative(workspaceRoot, info.resolvedPath);
    const ext = path.extname(rel).replace(/^\./, '');
    blocks.push(`### ${rel} (referenced via @${token}${info.truncated ? ', truncated' : ''})`);
    blocks.push('```' + (ext || ''));
    blocks.push(info.body);
    blocks.push('```');
    blocks.push('');
  }

  const mentions = Array.from(mentioned.entries()).map(([token, info]) => ({
    token,
    resolvedPath: info.resolvedPath,
    bytes: info.body.length,
    truncated: info.truncated,
  }));
  return { expanded: prompt + blocks.join('\n'), mentions };
}
