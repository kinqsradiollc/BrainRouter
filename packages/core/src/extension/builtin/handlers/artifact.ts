// ADR-041 D8 — artifact authoring. artifact_write creates or grows a versioned
// artifact in the workspace artifact store and captures it into session memory via
// the host's captureArtifactToMemory(). It is a session-scoped write with no
// approval gate or lease (the store versions edits itself), so it migrates cleanly.
// Body is the former case body verbatim (`this.x` → `ctx.host.x`).

import { createArtifact, updateArtifact, getArtifact } from '../../../artifact/artifactStore.js';
import { isArtifactKind, isArtifactFormat, type ArtifactKind, type ArtifactFormat } from '@kinqs/brainrouter-types';
import type { BuiltinToolHandler } from './registry.js';

export const artifactHandlers: Record<string, BuiltinToolHandler> = {
  artifact_write: async ({ args, host }) => {
    // §AV-4 — in-band artifact authoring. With `id` it grows an EXISTING
    // artifact (a new version, editedBy 'agent') — this is how a later turn
    // or a sub-agent targets the same artifact across sessions. Without `id`
    // it creates one. Content edits are versioned by the store (§AV-1).
    const content = typeof args.content === 'string' ? args.content : '';
    if (!content.trim() && !args.id) {
      throw new Error('artifact_write: `content` is required when creating a new artifact.');
    }
    const format: ArtifactFormat = isArtifactFormat(args.format) ? args.format : 'markdown';
    const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : '';
    if (id) {
      if (!getArtifact(host.workspaceRoot, id)) throw new Error(`artifact_write: no artifact "${id}" to update.`);
      const patch: Record<string, unknown> = { content, format };
      if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim();
      if (typeof args.summary === 'string') patch.summary = args.summary;
      if (typeof args.language === 'string' && args.language.trim()) patch.language = args.language.trim();
      const updated = updateArtifact(host.workspaceRoot, id, patch, { editedBy: 'agent', note: typeof args.note === 'string' ? args.note : undefined });
      if (!updated) throw new Error(`artifact_write: failed to update "${id}".`);
      await host.captureArtifactToMemory(updated);
      return `Updated artifact ${updated.id} → v${updated.currentVersion} (${updated.kind}, ${updated.format}): ${updated.title}`;
    }
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title) throw new Error('artifact_write: `title` is required when creating a new artifact.');
    const kind: ArtifactKind = isArtifactKind(args.kind) ? args.kind : 'markdown-report';
    const created = createArtifact(host.workspaceRoot, {
      kind, title, format, content,
      language: typeof args.language === 'string' ? args.language : undefined,
      summary: typeof args.summary === 'string' ? args.summary : undefined,
      sessionKey: host.sessionKey,
      editedBy: 'agent',
    });
    await host.captureArtifactToMemory(created);
    return `Created artifact ${created.id} (v1, ${created.kind}, ${created.format}): ${created.title}. Update it later with artifact_write({ id: "${created.id}", content }).`;
  },
};
