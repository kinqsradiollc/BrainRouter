/**
 * ActivityScreen (S-10) — cross-workspace dashboard of running/finished tasks.
 * M0 placeholder; M1 builds it on the ported `domain/workspace/dashboard` +
 * `runningIndicators` logic and the `fleet`/`globalDashboard` queries.
 */
import React from 'react';
import { Screen, EmptyState } from '../components/primitives/Screen';

export function ActivityScreen(): React.JSX.Element {
  return (
    <Screen title="Activity">
      <EmptyState title="No active tasks" detail="The task/workflow dashboard lands in Milestone 1 (S-10)." />
    </Screen>
  );
}
