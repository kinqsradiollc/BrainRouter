/**
 * ARTIFACT-INLINE (F2) — a compact artifact chip in the TRANSCRIPT, rendered
 * when the agent authors/updates an artifact (artifact_write). Sibling of
 * ChangesetCard / WorkflowCard; reuses the `.step` card shell so it reads as
 * part of the same visual language. "Open" pops the Artifacts side panel and
 * focuses this artifact by id (the panel selects it via the br-artifact-focus
 * signal wired at the row-source).
 */
import React from 'react';
import { Icon } from '../icons.js';
import { artifactWriteLine } from '../lib/artifacts/artifactWriteRow.js';

export function ArtifactCard({ artifactId, title, format, artifactKind, version, action, onOpen }: {
  artifactId: string;
  title: string;
  format: string;
  artifactKind?: string;
  version?: number;
  action: 'created' | 'updated';
  onOpen: (id: string) => void;
}): React.ReactElement {
  const sub = artifactWriteLine({ action, kind: artifactKind ?? '', version: version ?? 0 });
  return (
    <div className="step art-card">
      <span className="art-card-ic" aria-hidden><Icon name="file" size={14} /></span>
      <span className="art-card-main">
        <span className="art-card-title" title={title}>{title}</span>
        <span className="art-card-sub">{sub}</span>
      </span>
      <span className="art-card-fmt" title={`format: ${format}`}>{format}</span>
      <button className="art-card-open" onClick={() => onOpen(artifactId)} title="Open in the Artifacts panel">
        <Icon name="external" size={12} /> Open
      </button>
    </div>
  );
}
