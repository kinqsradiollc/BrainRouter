import React from 'react';
import { Icon } from './Icon.js';
import { pendingRefLabel } from './notesView.js';

/** Shared Notes rendering for an already-resolved workspace reference. */
export function RefChip({ uri, label, onOpen }: {
  uri: string;
  label?: string;
  onOpen: (uri: string) => void;
}): React.ReactElement {
  return (
    <button className="ws-ref-chip" title={uri} onClick={() => onOpen(uri)}>
      <Icon name="link" size={10} /> {label || pendingRefLabel(uri)}
    </button>
  );
}
