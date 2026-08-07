/**
 * ADR-029 A1/A3 — what a reference LOOKS like, decided once for every surface.
 *
 * Notes rendered live chips while the planner rendered the same reference as a
 * raw `brainrouter://…` string in its prose. That is not a cosmetic gap: it is
 * ADR-028's failure at the level of the workspace — two surfaces disagreeing
 * about the same object, so one of them looks broken to whoever notices. A
 * reference is one thing, so it gets one rendering, and a mode joins it by
 * passing its resolved labels rather than by writing its own chip.
 *
 * The label is RESOLVED and passed in (A3), never derived from the URI when one
 * is available: a chip that spelled out the target from the link would be a
 * snapshot, and the whole argument for live references is that snapshots go
 * quietly wrong.
 */
import React from 'react';
import { Icon } from '../../icons.js';
import { splitTextByWorkspaceRefs } from '@kinqs/brainrouter-core/workspace/references';
import { pendingRefLabel } from '../../lib/notes/notesView.js';

export function RefChip({ uri, label, onOpen }: {
  uri: string;
  /** The resolved line, or undefined until resolution answers. */
  label?: string;
  onOpen: (uri: string) => void;
}): React.ReactElement {
  return (
    <button className="ws-ref-chip" title={uri} onClick={() => onOpen(uri)}>
      {/* Before the label arrives the URI itself is shown: honest and stable,
          where showing nothing makes the chip appear to pop into existence. */}
      <Icon name="link" size={10} /> {label || pendingRefLabel(uri)}
    </button>
  );
}

/**
 * Prose with its references rendered as chips in place.
 *
 * The splitting is core's, not this file's — a second scanner in the renderer
 * would decide a different set of characters ends a URI, and then the same text
 * would chip differently in two modes.
 */
export function RefText({ text, labels, onOpen }: {
  text: string;
  labels: Record<string, string>;
  onOpen: (uri: string) => void;
}): React.ReactElement {
  const segments = splitTextByWorkspaceRefs(text);
  return (
    <>
      {segments.map((segment, index) => (
        segment.kind === 'ref'
          ? <RefChip key={`${index}:${segment.uri}`} uri={segment.uri} label={labels[segment.uri]} onOpen={onOpen} />
          : <React.Fragment key={index}>{segment.text}</React.Fragment>
      ))}
    </>
  );
}
