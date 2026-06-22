/**
 * ChangesScreen (S-07) — working-tree diff + commit/push (review-gated). M0
 * placeholder; M1 builds it on the ported `domain/view/reviewCode` +
 * `reviewGateUi` logic and the `changed-files`/`file-diff` queries.
 */
import React from 'react';
import { Screen, EmptyState } from '../components/primitives/Screen';

export function ChangesScreen(): React.JSX.Element {
  return (
    <Screen title="Changes">
      <EmptyState title="No changes to show" detail="The diff + commit/push surface lands in Milestone 1 (S-07)." />
    </Screen>
  );
}
