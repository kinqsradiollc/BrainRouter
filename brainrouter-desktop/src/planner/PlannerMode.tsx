/**
 * ADR-038 — Desktop's thin adapter around the shared Planner presentation.
 * The only Desktop-owned rendering concern left here is resolving workspace
 * references through the shell's existing chip component.
 */
import type { ReactElement } from 'react';
import {
  PlannerSurface,
  type PlannerSurfaceProps,
} from '@kinqs/brainrouter-ui/planner';

import { RefText } from '../components/workspace/RefChip.js';

export type { PlannerOps } from '@kinqs/brainrouter-ui/planner';

export function PlannerMode(props: PlannerSurfaceProps): ReactElement {
  return (
    <PlannerSurface
      {...props}
      renderNotesText={(text, labels, onOpen) => (
        <RefText text={text} labels={labels} onOpen={(uri) => onOpen?.(uri)} />
      )}
    />
  );
}
