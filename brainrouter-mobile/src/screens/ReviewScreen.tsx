/**
 * ReviewScreen (S-11 / S-12) — PR-style local review inbox + finding triage.
 * M0 placeholder; M1 builds it on the ported `domain/view/reviewWorkspace` +
 * `reviewCode` logic and the `review-*` queries.
 */
import React from 'react';
import { Screen, EmptyState } from '../components/primitives/Screen';

export function ReviewScreen(): React.JSX.Element {
  return (
    <Screen title="Review">
      <EmptyState title="Nothing to review" detail="The review inbox + finding triage lands in Milestone 1 (S-11/S-12)." />
    </Screen>
  );
}
