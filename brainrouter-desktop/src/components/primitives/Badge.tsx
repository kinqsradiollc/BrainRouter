/**
 * Chip — the shared `.req-link-chip` badge primitive (Button/Badge
 * consolidation). A small inline <span> used for link counts and quiet labels
 * across the Requirements / Annotations / Artifacts / Plan panels. Behavior-
 * preserving: the emitted class is identical to the old inline
 * `className="req-link-chip"` strings. Native span props pass through.
 */
import React from 'react';
import { chipClass } from '../../lib/ui/controlClass.js';

export function Chip({ className, ...rest }: React.HTMLAttributes<HTMLSpanElement>): React.ReactElement {
  return <span className={chipClass(className)} {...rest} />;
}
